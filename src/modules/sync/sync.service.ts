// Two-way convergence between this machine's SQLite and the shared store every
// machine syncs against. SQLite still answers every read and write in the app —
// nothing here sits in a request path — but it is no longer the only writer, so
// a sync pulls before it pushes.
//
// The model makes this tractable:
//   - ReadingEvent is append-only with immutable uuids, so merging is a set
//     union. Nothing is ever removed for being absent on one side; that
//     inference is what previously let a stale machine wipe a peer's history.
//   - Manga and SiteAdapter are mutable, so the newer updatedAt wins.
//   - Deletion is a value (Manga.deletedAt), not an absence, so it converges
//     under the same last-write-wins rule as any other field.
//
// Known limitation: last-write-wins compares wall clocks from different
// machines. For one person on two NTP-synced Macs who is not editing the same
// manga in two places at once, that is safe.
import { prisma } from "../../db/client";
import { publishLibraryChanged } from "../events/events.bus";
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

export interface SyncResult {
  pulled: { mangas: number; events: number; adapters: number; covers: number };
  pushed: { mangas: number; events: number; adapters: number; covers: number };
}

export interface SyncOptions {
  /** Cover bytes are slow, so they ride their own pass. */
  covers: boolean;
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
  updatedAt: true,
  deletedAt: true,
} as const;

const empty = (): SyncResult["pulled"] => ({
  mangas: 0,
  events: 0,
  adapters: 0,
  covers: 0,
});

/**
 * Pull, merge, push — in that order, so what this machine pushes already
 * reflects everything its peers had said.
 */
export async function syncWithReplica(
  target: SyncTarget,
  options: SyncOptions = { covers: false },
): Promise<SyncResult> {
  const pulled = empty();
  const pushed = empty();

  // ---- Mangas: last-write-wins in both directions -------------------------
  const remoteMangaDocs = await target.readMangas();
  const remoteMangas = remoteMangaDocs.map(fromMangaDoc);

  for (const remote of remoteMangas) {
    if (remote.normalizedSlug === "") {
      continue;
    }
    const local = await prisma.manga.findUnique({
      where: { normalizedSlug: remote.normalizedSlug },
      select: mangaMetaSelect,
    });

    if (local === null) {
      await prisma.manga.create({
        data: {
          canonicalName: remote.canonicalName,
          normalizedSlug: remote.normalizedSlug,
          coverUrl: remote.coverUrl,
          coverImageType: remote.coverImageType,
          coverVersion: remote.coverVersion,
          status: remote.status,
          tags: remote.tags,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
          deletedAt: remote.deletedAt,
        },
      });
      pulled.mangas += 1;
      continue;
    }

    if (remote.updatedAt.getTime() > local.updatedAt.getTime()) {
      await prisma.manga.update({
        where: { normalizedSlug: remote.normalizedSlug },
        data: {
          canonicalName: remote.canonicalName,
          coverUrl: remote.coverUrl,
          coverImageType: remote.coverImageType,
          coverVersion: remote.coverVersion,
          status: remote.status,
          tags: remote.tags,
          updatedAt: remote.updatedAt,
          deletedAt: remote.deletedAt,
        },
      });
      pulled.mangas += 1;
    }
  }

  // ---- Events: set union, never a deletion --------------------------------
  const remoteEventIds = await target.readEventIds();
  const localEvents = await prisma.readingEvent.findMany({
    select: { id: true, mangaId: true },
  });
  const localEventIds = new Set(localEvents.map((row) => row.id));

  const missingLocally = [...remoteEventIds].filter(
    (id) => !localEventIds.has(id),
  );
  if (missingLocally.length > 0) {
    const docs = await target.readEventDocs(missingLocally);
    const incoming = docs.map(fromEventDoc);
    // Mangas were merged first, so every slug an event references already
    // exists locally — this is the step that translates a peer's manga
    // identity into this machine's own uuid.
    const slugToId = new Map(
      (
        await prisma.manga.findMany({
          select: { id: true, normalizedSlug: true },
        })
      ).map((row) => [row.normalizedSlug, row.id]),
    );
    const rows = incoming
      .map((event) => {
        const mangaId = slugToId.get(event.mangaSlug);
        return mangaId === undefined || event.id === ""
          ? null
          : {
              id: event.id,
              mangaId,
              chapterLabel: event.chapterLabel,
              chapterNumber: event.chapterNumber,
              sourceUrl: event.sourceUrl,
              sourceDomain: event.sourceDomain,
              readAt: event.readAt,
            };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
    if (rows.length > 0) {
      await prisma.readingEvent.createMany({ data: rows });
      pulled.events = rows.length;
    }
  }

  // ---- Adapters: last-write-wins ------------------------------------------
  const remoteAdapters = (await target.readAdapters()).map(fromAdapterDoc);
  for (const remote of remoteAdapters) {
    if (remote.domain === "") {
      continue;
    }
    const local = await prisma.siteAdapter.findUnique({
      where: { domain: remote.domain },
    });
    if (
      local === null ||
      remote.updatedAt.getTime() > local.updatedAt.getTime()
    ) {
      await prisma.siteAdapter.upsert({
        where: { domain: remote.domain },
        create: {
          domain: remote.domain,
          titleSelector: remote.titleSelector,
          chapterSelector: remote.chapterSelector,
          chapterUrlRegex: remote.chapterUrlRegex,
          createdAt: remote.createdAt,
          updatedAt: remote.updatedAt,
        },
        update: {
          titleSelector: remote.titleSelector,
          chapterSelector: remote.chapterSelector,
          chapterUrlRegex: remote.chapterUrlRegex,
          updatedAt: remote.updatedAt,
        },
      });
      pulled.adapters += 1;
    }
  }

  // ---- Push whatever is newer or missing on the other side ----------------
  const [localMangas, coveredRows, allLocalEvents, localAdapters] =
    await Promise.all([
      prisma.manga.findMany({ select: mangaMetaSelect }),
      // Ids only: the bytes stay in SQLite until the cover pass asks for them.
      prisma.manga.findMany({
        where: { coverImage: { not: null } },
        select: { normalizedSlug: true, coverVersion: true },
      }),
      prisma.readingEvent.findMany({
        include: { manga: { select: { normalizedSlug: true } } },
      }),
      prisma.siteAdapter.findMany(),
    ]);

  const covered = new Map(
    coveredRows.map((row) => [row.normalizedSlug, row.coverVersion]),
  );
  const remoteBySlug = new Map(
    remoteMangas.map((doc) => [doc.normalizedSlug, doc]),
  );
  const mangaDocsToPush = localMangas
    .filter((row) => {
      const remote = remoteBySlug.get(row.normalizedSlug);
      return (
        remote === undefined ||
        row.updatedAt.getTime() > remote.updatedAt.getTime()
      );
    })
    .map((row) =>
      toMangaDoc({ ...row, hasStoredCover: covered.has(row.normalizedSlug) }),
    );
  await target.upsertMangas(mangaDocsToPush);
  pushed.mangas = mangaDocsToPush.length;

  const eventDocsToPush = allLocalEvents
    .filter((row) => !remoteEventIds.has(row.id))
    .map((row) => toEventDoc(row, row.manga.normalizedSlug));
  await target.insertEvents(eventDocsToPush);
  pushed.events = eventDocsToPush.length;

  const remoteAdapterByDomain = new Map(
    remoteAdapters.map((doc) => [doc.domain, doc]),
  );
  const adapterDocsToPush = localAdapters
    .filter((row) => {
      const remote = remoteAdapterByDomain.get(row.domain);
      return (
        remote === undefined ||
        row.updatedAt.getTime() > remote.updatedAt.getTime()
      );
    })
    .map(toAdapterDoc);
  await target.upsertAdapters(adapterDocsToPush);
  pushed.adapters = adapterDocsToPush.length;

  if (options.covers) {
    const moved = await syncCovers(target, covered, remoteMangas);
    pulled.covers = moved.pulled;
    pushed.covers = moved.pushed;
  }

  if (pulled.mangas + pulled.events + pulled.adapters + pulled.covers > 0) {
    // An open dashboard should show what another machine recorded.
    publishLibraryChanged();
  }

  return { pulled, pushed };
}

/**
 * Cover bytes, both directions, driven by coverVersion so nothing moves unless
 * the image actually changed. Kept out of the metadata path because a cover
 * measured ~790 ms per MB against the cluster and can weigh 5 MB.
 */
async function syncCovers(
  target: SyncTarget,
  localVersions: Map<string, number>,
  remoteMangas: ReturnType<typeof fromMangaDoc>[],
): Promise<{ pulled: number; pushed: number }> {
  const remoteVersions = await target.readCoverVersions();
  let pulled = 0;
  let pushed = 0;

  // Pull: a peer has newer bytes than anything stored here.
  for (const remote of remoteMangas) {
    const remoteVersion = remoteVersions.get(remote.normalizedSlug);
    if (remoteVersion === undefined) {
      continue;
    }
    const localVersion = localVersions.get(remote.normalizedSlug);
    if (localVersion !== undefined && localVersion >= remoteVersion) {
      continue;
    }
    const doc = await target.readCover(remote.normalizedSlug);
    const cover = doc === null ? null : fromCoverDoc(doc);
    if (cover === null) {
      continue;
    }
    await prisma.manga.update({
      where: { normalizedSlug: cover.normalizedSlug },
      data: {
        // Copy rather than hand over the driver's buffer: it may be a view onto
        // a shared pool, the same hazard library.service.ts guards against.
        coverImage: new Uint8Array(cover.coverImage),
        coverImageType: cover.coverImageType,
      },
    });
    pulled += 1;
    localVersions.set(cover.normalizedSlug, cover.coverVersion);
  }

  // Push: this machine has bytes the shared store lacks or has stale.
  for (const [slug, version] of localVersions) {
    if (remoteVersions.get(slug) === version) {
      continue;
    }
    const row = await prisma.manga.findUnique({
      where: { normalizedSlug: slug },
      select: {
        normalizedSlug: true,
        coverImage: true,
        coverImageType: true,
        coverVersion: true,
      },
    });
    if (row?.coverImage == null) {
      continue;
    }
    await target.upsertCovers([
      toCoverDoc({
        normalizedSlug: row.normalizedSlug,
        coverImage: row.coverImage,
        coverImageType: row.coverImageType,
        coverVersion: row.coverVersion,
      }),
    ]);
    pushed += 1;
  }

  // The one sanctioned removal: the merged manga says there are no bytes, so
  // the stored image is not "missing", it was cleared on purpose.
  const clearedSlugs = [...remoteVersions.keys()].filter(
    (slug) => !localVersions.has(slug),
  );
  const clearedByValue = clearedSlugs.filter((slug) => {
    const merged = remoteMangas.find((doc) => doc.normalizedSlug === slug);
    return merged !== undefined && merged.coverVersion > 0;
  });
  await target.deleteCovers(clearedByValue);

  return { pulled, pushed };
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
 * Replaces the local database with the shared store. Ordinary machine changes
 * no longer need this — a plain sync pulls everything — so it exists for the
 * one case a merge cannot serve: the local SQLite is corrupt or suspect and
 * should be thrown away.
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

  await prisma.manga.deleteMany();
  await prisma.siteAdapter.deleteMany();

  const result = await syncWithReplica(target, { covers: true });
  return {
    kind: "restored",
    mangas: result.pulled.mangas,
    events: result.pulled.events,
    adapters: result.pulled.adapters,
    covers: result.pulled.covers,
  };
}
