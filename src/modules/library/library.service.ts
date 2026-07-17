import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { publishLibraryChanged } from "../events/events.bus";

export interface LibraryFilters {
  domain?: string;
  since?: Date;
}

export interface LibraryProjection {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  status: string;
  tags: string;
  reachedChapter: { number: number; label: string } | null;
  lastActivity: { readAt: Date; chapterLabel: string } | null;
  lastSourceUrl: string | null;
  readCount: number;
  sourceDomains: string[];
}

export interface UpdateMangaInput {
  canonicalName?: string;
  status?: string;
  tags?: string[];
  // string = manual cover; null = clear (the next reading may refill it)
  coverUrl?: string | null;
}

/**
 * The library is a projection over the append-only event log:
 * - reachedChapter = the highest parsed chapter across the WHOLE history
 *   (real progress; a low-chapter event after a server change never lowers it)
 * - lastActivity = the most recent event, regardless of its chapter
 * Entries come back most-recently-read first (mangas without events last).
 * Volume is tiny (tens of events/day), so loading events per manga and
 * projecting in memory is simpler and strictly more correct than groupBy
 * (which cannot return the label of the max row).
 */
export async function getLibrary(
  filters: LibraryFilters,
): Promise<LibraryProjection[]> {
  const conditions = [];
  if (filters.domain) {
    conditions.push({ events: { some: { sourceDomain: filters.domain } } });
  }
  if (filters.since) {
    conditions.push({ events: { some: { readAt: { gte: filters.since } } } });
  }

  const mangas = await prisma.manga.findMany({
    where: conditions.length > 0 ? { AND: conditions } : undefined,
    include: { events: { orderBy: { readAt: "desc" } } },
    orderBy: { createdAt: "asc" },
  });

  return mangas
    .map(project)
    .sort(
      (a, b) =>
        (b.lastActivity?.readAt.getTime() ?? 0) -
        (a.lastActivity?.readAt.getTime() ?? 0),
    );
}

export async function getMangaHistory(
  id: string,
): Promise<{ manga: Manga; events: ReadingEvent[] } | null> {
  const manga = await prisma.manga.findUnique({
    where: { id },
    include: { events: { orderBy: { readAt: "desc" } } },
  });
  if (!manga) {
    return null;
  }
  const { events, ...rest } = manga;
  return { manga: rest, events };
}

/**
 * Manual corrections from the dashboard: display name, reading status and
 * tags. normalizedSlug is deliberately untouched: it is the dedup key, and
 * changing it would either break future matching or collide with another
 * manga.
 */
export async function updateManga(
  id: string,
  input: UpdateMangaInput,
): Promise<Manga | null> {
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  const manga = await prisma.manga.update({
    where: { id },
    data: {
      ...(input.canonicalName !== undefined
        ? { canonicalName: input.canonicalName }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
      ...(input.coverUrl !== undefined ? { coverUrl: input.coverUrl } : {}),
    },
  });
  publishLibraryChanged();
  return manga;
}

/**
 * Explicit user deletion from the dashboard; events fall with the manga via
 * onDelete: Cascade. This is the one sanctioned way data leaves the log.
 */
export async function deleteManga(id: string): Promise<boolean> {
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return false;
  }
  await prisma.manga.delete({ where: { id } });
  publishLibraryChanged();
  return true;
}

function project(manga: Manga & { events: ReadingEvent[] }): LibraryProjection {
  // events arrive desc by readAt; strict > keeps the most recent among ties
  let reachedChapter: { number: number; label: string } | null = null;
  for (const event of manga.events) {
    if (
      event.chapterNumber !== null &&
      (reachedChapter === null || event.chapterNumber > reachedChapter.number)
    ) {
      reachedChapter = {
        number: event.chapterNumber,
        label: event.chapterLabel,
      };
    }
  }

  const latest = manga.events[0] ?? null;

  return {
    id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
    coverUrl: manga.coverUrl,
    status: manga.status,
    tags: manga.tags,
    reachedChapter,
    lastActivity: latest
      ? { readAt: latest.readAt, chapterLabel: latest.chapterLabel }
      : null,
    lastSourceUrl: latest?.sourceUrl ?? null,
    readCount: manga.events.length,
    sourceDomains: [
      ...new Set(manga.events.map((event) => event.sourceDomain)),
    ],
  };
}
