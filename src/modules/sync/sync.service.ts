// Push-only replication to the off-site replica. SQLite stays the single source
// of truth: nothing here ever reads from the replica to answer a request, and
// the only inbound path is an explicit restore.
//
// The push is a full reconciliation by key difference rather than a delta feed.
// That is a deliberate trade: at this volume (tens of events a day) reading the
// remote key set costs a few hundred KB, and in exchange the replica needs no
// watermark table, no `updatedAt` column, and no Prisma migration — and a push
// that failed while offline is fully repaired by the next one.
import { prisma } from "../../db/client";
import {
  fromAdapterDoc,
  fromCoverDoc,
  fromEventDoc,
  fromMangaDoc,
  toAdapterDoc,
  toCoverDoc,
  toEventDoc,
  toMangaDoc,
} from "./sync.mapper";
import type { SyncTarget } from "./sync.target";

export interface PushResult {
  mangas: { upserted: number; deleted: number };
  events: { inserted: number; deleted: number };
  adapters: { upserted: number; deleted: number };
  /** Null when this push skipped the cover pass. */
  covers: { uploaded: number; deleted: number } | null;
  /** False when the push was additive-only; every `deleted` is then 0. */
  deletionsApplied: boolean;
}

export type PushOutcome =
  | ({ kind: "pushed" } & PushResult)
  // An empty local database is never evidence that the replica should be
  // emptied — it means a fresh machine, or one that just lost its data.
  | { kind: "skipped"; reason: "local-empty" };

export interface PushOptions {
  covers: boolean;
  /**
   * Whether local absence may remove documents from the replica. False for the
   * catch-up push at boot, which has no evidence anything was deleted — only a
   * push triggered by a real local change, or asked for explicitly, does.
   */
  allowDeletions: boolean;
}

const mangaMetaSelect = {
  id: true,
  canonicalName: true,
  normalizedSlug: true,
  coverUrl: true,
  coverImageType: true,
  coverVersion: true,
  status: true,
  tags: true,
  createdAt: true,
} as const;

/**
 * Reconciles the replica against SQLite.
 *
 * Mangas and adapters are re-upserted wholesale: they are mutable and the
 * schema has no `updatedAt`, so there is no honest way to tell which ones
 * changed — and at a few hundred bytes per document, guessing is not worth a
 * migration. Events are immutable and append-only, so only the missing ids move.
 *
 * Deletions are the dangerous direction, so they are gated twice: an empty local
 * database refuses to push at all, and callers must opt in. Without that, the
 * first boot on a fresh machine mirrors nothing over the replica and destroys
 * the very backup it was installed to read.
 */
export async function pushToReplica(
  target: SyncTarget,
  options: PushOptions = { covers: false, allowDeletions: false },
): Promise<PushOutcome> {
  const [mangaRows, coveredRows, eventRows, adapterRows] = await Promise.all([
    prisma.manga.findMany({ select: mangaMetaSelect }),
    // Ids only: the bytes stay in SQLite until the cover pass asks for them.
    prisma.manga.findMany({
      where: { coverImage: { not: null } },
      select: { id: true, coverVersion: true },
    }),
    prisma.readingEvent.findMany(),
    prisma.siteAdapter.findMany(),
  ]);

  if (mangaRows.length === 0 && adapterRows.length === 0) {
    return { kind: "skipped", reason: "local-empty" };
  }

  const keys = await target.readKeys();
  const covered = new Map(coveredRows.map((row) => [row.id, row.coverVersion]));

  const mangaDocs = mangaRows.map((row) =>
    toMangaDoc({ ...row, hasStoredCover: covered.has(row.id) }),
  );
  const localMangaIds = new Set(mangaRows.map((row) => row.id));
  const staleMangaIds = [...keys.mangaIds].filter(
    (id) => !localMangaIds.has(id),
  );

  const localEventIds = new Set(eventRows.map((row) => row.id));
  const newEventDocs = eventRows
    .filter((row) => !keys.eventIds.has(row.id))
    .map(toEventDoc);
  // SQLite cascades events when a manga is deleted; the replica has no foreign
  // keys, so the same cascade only happens because this diff catches the orphans.
  const staleEventIds = [...keys.eventIds].filter(
    (id) => !localEventIds.has(id),
  );

  const adapterDocs = adapterRows.map(toAdapterDoc);
  const localDomains = new Set(adapterRows.map((row) => row.domain));
  const staleDomains = [...keys.adapterDomains].filter(
    (domain) => !localDomains.has(domain),
  );

  // Orphan cover documents are pruned on every push — it is an id diff, no bytes
  // move — while uploading them is gated behind the cover pass.
  const staleCoverIds = [...keys.coverVersions.keys()].filter(
    (id) => !covered.has(id),
  );

  await target.upsertMangas(mangaDocs);
  await target.insertEvents(newEventDocs);
  await target.upsertAdapters(adapterDocs);

  if (options.allowDeletions) {
    // Events go first so a manga is never left without its history remotely.
    await target.deleteEvents(staleEventIds);
    await target.deleteMangas(staleMangaIds);
    await target.deleteAdapters(staleDomains);
    await target.deleteCovers(staleCoverIds);
  }

  const uploaded = options.covers
    ? await pushCovers(target, covered, keys.coverVersions)
    : null;

  const deleted = (ids: string[]): number =>
    options.allowDeletions ? ids.length : 0;

  return {
    kind: "pushed",
    deletionsApplied: options.allowDeletions,
    mangas: { upserted: mangaDocs.length, deleted: deleted(staleMangaIds) },
    events: { inserted: newEventDocs.length, deleted: deleted(staleEventIds) },
    adapters: { upserted: adapterDocs.length, deleted: deleted(staleDomains) },
    covers:
      uploaded === null ? null : { uploaded, deleted: deleted(staleCoverIds) },
  };
}

/**
 * Uploads only the covers whose version moved. Rows are fetched one at a time
 * because each can be 5 MB, and the round trip alone measured ~790 ms per MB
 * against the cluster — which is exactly why this never runs inline with a
 * reading being recorded.
 */
async function pushCovers(
  target: SyncTarget,
  local: Map<string, number>,
  remote: Map<string, number>,
): Promise<number> {
  const outdated = [...local.entries()]
    .filter(([id, version]) => remote.get(id) !== version)
    .map(([id]) => id);

  let uploaded = 0;
  for (const id of outdated) {
    const row = await prisma.manga.findUnique({
      where: { id },
      select: {
        id: true,
        coverImage: true,
        coverImageType: true,
        coverVersion: true,
      },
    });
    if (row?.coverImage == null) {
      // Cleared between the id scan and now; the next push prunes the document.
      continue;
    }
    await target.upsertCovers([
      toCoverDoc({
        id: row.id,
        coverImage: row.coverImage,
        coverImageType: row.coverImageType,
        coverVersion: row.coverVersion,
      }),
    ]);
    uploaded += 1;
  }
  return uploaded;
}

export type RestoreOutcome =
  | {
      kind: "restored";
      mangas: number;
      events: number;
      adapters: number;
      covers: number;
    }
  | {
      kind: "local-not-empty";
      mangas: number;
      events: number;
      adapters: number;
    };

/**
 * Rebuilds SQLite from the replica. This is the half that makes the backup
 * worth anything — an untested backup is not a backup.
 *
 * Refuses to run over a populated database unless forced, because the replica
 * is a mirror of some machine's state, not necessarily a superset of this one's.
 */
export async function restoreFromReplica(
  target: SyncTarget,
  options: { force: boolean } = { force: false },
): Promise<RestoreOutcome> {
  const [mangaCount, eventCount, adapterCount] = await Promise.all([
    prisma.manga.count(),
    prisma.readingEvent.count(),
    prisma.siteAdapter.count(),
  ]);

  if (!options.force && mangaCount + eventCount + adapterCount > 0) {
    return {
      kind: "local-not-empty",
      mangas: mangaCount,
      events: eventCount,
      adapters: adapterCount,
    };
  }

  const [mangaDocs, eventDocs, adapterDocs] = await Promise.all([
    target.readMangas(),
    target.readEvents(),
    target.readAdapters(),
  ]);

  const mangas = mangaDocs.map(fromMangaDoc).filter((row) => row.id !== "");
  const restoredIds = new Set(mangas.map((row) => row.id));
  // SQLite enforces the foreign key the replica does not: an event whose manga
  // did not come back would abort the whole restore.
  const events = eventDocs
    .map(fromEventDoc)
    .filter((row) => row.id !== "" && restoredIds.has(row.mangaId));
  const adapters = adapterDocs
    .map(fromAdapterDoc)
    .filter((row) => row.domain !== "");

  // Deleting mangas cascades to their events, so this clears both.
  await prisma.manga.deleteMany();
  await prisma.siteAdapter.deleteMany();

  await prisma.manga.createMany({ data: mangas });
  await prisma.readingEvent.createMany({ data: events });
  await prisma.siteAdapter.createMany({ data: adapters });

  let covers = 0;
  for (const doc of mangaDocs) {
    if (doc.hasStoredCover !== true) {
      continue;
    }
    const cover = fromCoverDoc((await target.readCover(String(doc._id))) ?? {});
    if (cover === null || !restoredIds.has(cover.mangaId)) {
      continue;
    }
    await prisma.manga.update({
      where: { id: cover.mangaId },
      data: {
        // Copy rather than hand over the driver's buffer: it may be a view onto
        // a shared pool, the same hazard library.service.ts guards against when
        // reading covers back out.
        coverImage: new Uint8Array(cover.coverImage),
        coverImageType: cover.coverImageType,
      },
    });
    covers += 1;
  }

  return {
    kind: "restored",
    mangas: mangas.length,
    events: events.length,
    adapters: adapters.length,
    covers,
  };
}
