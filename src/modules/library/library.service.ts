import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";

export interface LibraryFilters {
  domain?: string;
  since?: Date;
}

export interface LibraryProjection {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  reachedChapter: { number: number; label: string } | null;
  lastActivity: { readAt: Date; chapterLabel: string } | null;
  readCount: number;
  sourceDomains: string[];
}

/**
 * The library is a projection over the append-only event log:
 * - reachedChapter = the highest parsed chapter across the WHOLE history
 *   (real progress; a low-chapter event after a server change never lowers it)
 * - lastActivity = the most recent event, regardless of its chapter
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

  return mangas.map(project);
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
 * Fixes only the display name. normalizedSlug is deliberately untouched: it
 * is the dedup key, and changing it would either break future matching or
 * collide with another manga.
 */
export async function updateCanonicalName(
  id: string,
  canonicalName: string,
): Promise<Manga | null> {
  const existing = await prisma.manga.findUnique({ where: { id } });
  if (!existing) {
    return null;
  }
  return prisma.manga.update({ where: { id }, data: { canonicalName } });
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
    reachedChapter,
    lastActivity: latest
      ? { readAt: latest.readAt, chapterLabel: latest.chapterLabel }
      : null,
    readCount: manga.events.length,
    sourceDomains: [
      ...new Set(manga.events.map((event) => event.sourceDomain)),
    ],
  };
}
