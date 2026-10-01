/**
 * The library's read model, kept current.
 *
 * Reading the library used to mean loading every manga — every stored cover's
 * bytes included — and every event, then projecting the cards in memory. That
 * was every request, and the cover endpoint did it once per cover: the grid's
 * first paint read the whole database a hundred and forty times. It now reads
 * LibraryEntry, which holds each card as it should be shown.
 *
 * Who keeps it current is the database: triggers mark the manga rows whose
 * card may have changed (LibraryDirty), whatever wrote them — ingestion, an
 * edit, a merge, a deletion, a sync pull. `refreshProjection` recomputes just
 * the cards behind those marks before any read, so a read never sees a stale
 * card and a write never has to remember to update one.
 */
// Here rather than in the library module because duplicates reads it too, and
// modules never import each other: it is the read model's data access, beside
// the client and the migrator.
import { Prisma } from "../generated/prisma/client";
import { type MangaGroup, resolveMangaGroups } from "../lib/manga-groups";
import { chapterKey } from "../lib/normalize";
import { searchKeyOf } from "../lib/search-key";
import { prisma } from "./client";

/** What a card with no events yet orders by: last, behind every read one. */
export const NEVER_READ = new Date(0);

/** Cards recomputed per round trip; bounds the size of every IN list. */
const BATCH = 400;

/**
 * The most values one `IN (…)` may carry. The libSQL driver refuses a query
 * past its bound-parameter limit ("query parameter limit supported by your
 * database is exceeded"), which no library of a few hundred mangas reaches
 * and one of ten thousand reaches on its first read.
 */
const MAX_IN = 500;

/**
 * Runs `query` over `values` in slices of MAX_IN and concatenates the
 * answers: what any lookup by a list that grows with the library goes through.
 */
export async function inChunks<T>(
  values: readonly string[],
  query: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < values.length; start += MAX_IN) {
    results.push(...(await query(values.slice(start, start + MAX_IN))));
  }
  return results;
}

/**
 * Past this many marked cards — and this share of the library — rebuilding
 * everything is cheaper than resolving them one group at a time. The first
 * read after the migration (every manga marked) is the obvious case.
 */
const FULL_REBUILD_MIN = 200;
const FULL_REBUILD_SHARE = 0.25;

interface Identity {
  id: string;
  normalizedSlug: string;
  mergedIntoSlug: string | null;
  deletedAt: Date | null;
}

/** The columns of an event the card is computed from. */
export interface ProjectedEvent {
  mangaId: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
}

/** The canonical row's columns a card shows. */
export interface CanonicalRow {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  coverVersion: number;
  status: string;
  tags: string;
}

/**
 * One card from its canonical row and the events of its whole group, most
 * recent first. The rules are the ones the library always had: progress is
 * the highest parsed chapter, last activity the newest event whatever its
 * chapter, and a chapter read on two merged sites counts once.
 */
export function projectEntry(
  canonical: CanonicalRow,
  events: readonly ProjectedEvent[],
  aliasCount: number,
  hasStoredCover: boolean,
): Prisma.LibraryEntryCreateManyInput {
  // events arrive desc by readAt; strict > keeps the most recent among ties
  let reached: { number: number; label: string } | null = null;
  for (const event of events) {
    if (
      event.chapterNumber !== null &&
      (reached === null || event.chapterNumber > reached.number)
    ) {
      reached = { number: event.chapterNumber, label: event.chapterLabel };
    }
  }
  const latest = events[0] ?? null;
  const key = searchKeyOf(canonical.canonicalName);
  return {
    mangaId: canonical.id,
    canonicalName: canonical.canonicalName,
    normalizedSlug: canonical.normalizedSlug,
    searchKey: key,
    sortKey: key,
    coverUrl: canonical.coverUrl,
    coverVersion: canonical.coverVersion,
    hasStoredCover,
    status: canonical.status,
    tags: canonical.tags,
    reachedNumber: reached?.number ?? null,
    reachedLabel: reached?.label ?? null,
    lastReadAt: latest?.readAt ?? NEVER_READ,
    lastChapterLabel: latest?.chapterLabel ?? null,
    lastSourceUrl: latest?.sourceUrl ?? null,
    readCount: new Set(events.map(chapterKey)).size,
    sourceDomains: JSON.stringify([
      ...new Set(events.map((event) => event.sourceDomain)),
    ]),
    aliasCount,
  };
}

// Serialized: two requests arriving together run one refresh after the other,
// and the second usually finds nothing left to do.
let queue: Promise<void> = Promise.resolve();

/** Brings the projection up to date with every mark the triggers left. */
export function refreshProjection(): Promise<void> {
  const run = queue.then(refreshOnce);
  // The queue must outlive a failed run; the caller still gets the failure.
  queue = run.catch(() => undefined);
  return run;
}

async function refreshOnce(): Promise<void> {
  const marks = await prisma.libraryDirty.findMany();
  if (marks.length === 0) {
    return;
  }
  const lastSeq = marks.reduce((max, mark) => Math.max(max, mark.seq), 0);

  // Group membership is resolved from every row's identity — four short
  // columns, so this stays cheap at tens of thousands of mangas — because a
  // merge pointer can make any row part of any card.
  const identities = await prisma.manga.findMany({
    select: {
      id: true,
      normalizedSlug: true,
      mergedIntoSlug: true,
      deletedAt: true,
    },
  });
  const groups = resolveMangaGroups(identities);
  const groupOf = new Map<string, MangaGroup<Identity>>();
  for (const group of groups) {
    for (const memberId of group.memberIds) {
      groupOf.set(memberId, group);
    }
  }

  const markedIds = marks.map((mark) => mark.mangaId);
  // The card a marked row used to belong to changes too: unmerging an alias
  // leaves its old card holding events that are no longer its own.
  const previous = await inChunks(markedIds, (chunk) =>
    prisma.libraryMember.findMany({ where: { memberId: { in: chunk } } }),
  );

  const affected = new Set<string>();
  for (const id of [
    ...markedIds,
    ...previous.map((member) => member.canonicalId),
  ]) {
    const group = groupOf.get(id);
    if (group !== undefined) {
      affected.add(group.canonical.id);
    }
  }

  const rebuildAll =
    affected.size >= FULL_REBUILD_MIN &&
    affected.size >= groups.length * FULL_REBUILD_SHARE;

  if (rebuildAll) {
    await prisma.$transaction([
      prisma.libraryEntryDomain.deleteMany(),
      prisma.libraryEntry.deleteMany(),
      prisma.libraryMember.deleteMany(),
    ]);
    await writeGroups(groups);
  } else {
    // Rows that no longer own a card — now an alias, or gone altogether —
    // lose the card they had.
    const noLongerCanonical = [
      ...new Set([
        ...markedIds,
        ...previous.map((member) => member.canonicalId),
      ]),
    ].filter((id) => groupOf.get(id)?.canonical.id !== id);
    const gone = markedIds.filter((id) => !groupOf.has(id));
    // Domains by hand rather than by the foreign key's cascade, which only
    // runs where SQLite was told to enforce foreign keys.
    await inChunks(noLongerCanonical, (chunk) =>
      prisma.$transaction([
        prisma.libraryEntryDomain.deleteMany({
          where: { mangaId: { in: chunk } },
        }),
        prisma.libraryEntry.deleteMany({ where: { mangaId: { in: chunk } } }),
      ]),
    );
    await inChunks(gone, (chunk) =>
      prisma.libraryMember
        .deleteMany({ where: { memberId: { in: chunk } } })
        .then((result) => [result]),
    );
    await writeGroups(
      groups.filter((group) => affected.has(group.canonical.id)),
    );
  }

  // Only the marks read above: one set while this ran is still there for the
  // next refresh, with a higher seq.
  await prisma.libraryDirty.deleteMany({ where: { seq: { lte: lastSeq } } });
}

async function writeGroups(
  groups: readonly MangaGroup<Identity>[],
): Promise<void> {
  for (let start = 0; start < groups.length; start += BATCH) {
    await writeBatch(groups.slice(start, start + BATCH));
  }
}

async function writeBatch(
  groups: readonly MangaGroup<Identity>[],
): Promise<void> {
  const alive = groups.filter((group) => group.canonical.deletedAt === null);
  const canonicalIds = alive.map((group) => group.canonical.id);
  const memberIds = alive.flatMap((group) => group.memberIds);

  const [rows, stored, events] = await Promise.all([
    prisma.manga.findMany({
      where: { id: { in: canonicalIds } },
      select: {
        id: true,
        canonicalName: true,
        normalizedSlug: true,
        coverUrl: true,
        coverVersion: true,
        status: true,
        tags: true,
      },
    }),
    storedCoverIds(canonicalIds),
    // A batch of cards can hold more members than one IN may carry.
    inChunks(memberIds, (chunk) =>
      prisma.readingEvent.findMany({
        where: { mangaId: { in: chunk } },
        select: {
          mangaId: true,
          chapterLabel: true,
          chapterNumber: true,
          sourceUrl: true,
          sourceDomain: true,
          readAt: true,
        },
      }),
    ),
  ]);

  const rowById = new Map(rows.map((row) => [row.id, row]));
  const eventsByMember = new Map<string, ProjectedEvent[]>();
  for (const event of events) {
    const list = eventsByMember.get(event.mangaId) ?? [];
    list.push(event);
    eventsByMember.set(event.mangaId, list);
  }

  const entries: Prisma.LibraryEntryCreateManyInput[] = [];
  const domains: Prisma.LibraryEntryDomainCreateManyInput[] = [];
  for (const group of alive) {
    const row = rowById.get(group.canonical.id);
    if (row === undefined) {
      continue; // deleted between the identity read and this one
    }
    const groupEvents = group.memberIds
      .flatMap((id) => eventsByMember.get(id) ?? [])
      .toSorted((a, b) => b.readAt.getTime() - a.readAt.getTime());
    const entry = projectEntry(
      row,
      groupEvents,
      group.aliases.length,
      stored.has(row.id),
    );
    entries.push(entry);
    for (const domain of JSON.parse(entry.sourceDomains) as string[]) {
      domains.push({ mangaId: row.id, domain });
    }
  }

  // Deleted cards keep their members: an id of theirs must still resolve, to
  // the canonical, so the history and cover endpoints can say it is gone.
  const members = groups.flatMap((group) =>
    group.memberIds.map((memberId) => ({
      memberId,
      canonicalId: group.canonical.id,
    })),
  );
  const allCanonicalIds = groups.map((group) => group.canonical.id);
  const allMemberIds = groups.flatMap((group) => group.memberIds);
  const memberChunks: string[][] = [];
  for (let start = 0; start < allMemberIds.length; start += MAX_IN) {
    memberChunks.push(allMemberIds.slice(start, start + MAX_IN));
  }

  await prisma.$transaction([
    prisma.libraryEntryDomain.deleteMany({
      where: { mangaId: { in: allCanonicalIds } },
    }),
    prisma.libraryEntry.deleteMany({
      where: { mangaId: { in: allCanonicalIds } },
    }),
    ...memberChunks.map((chunk) =>
      prisma.libraryMember.deleteMany({ where: { memberId: { in: chunk } } }),
    ),
    prisma.libraryEntry.createMany({ data: entries }),
    prisma.libraryEntryDomain.createMany({ data: domains }),
    prisma.libraryMember.createMany({ data: members }),
  ]);
}

/** Which of these mangas have cover bytes stored, without reading the bytes. */
export async function storedCoverIds(
  ids: readonly string[],
): Promise<Set<string>> {
  const rows = await inChunks(ids, (chunk) =>
    prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Manga" WHERE "coverImage" IS NOT NULL AND "id" IN (${Prisma.join(chunk)})`,
    ),
  );
  return new Set(rows.map((row) => row.id));
}
