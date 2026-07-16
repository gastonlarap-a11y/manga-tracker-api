import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { normalizeSlug, parseChapterNumber } from "../../lib/normalize";

export interface RecordReadingEventInput {
  mangaName: string;
  chapterLabel: string;
  sourceUrl: string;
}

// Reloading or reopening a tab re-reports the chapter the reader is already
// on; within this window that is browser noise, not a re-read.
const DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Records one reading. The server derives slug, domain and chapter number —
 * clients are never trusted with them. Events are append-only: nothing is
 * ever updated or deleted, and a LOWER chapter still inserts (that is exactly
 * the "site changed servers" case; the library projection takes
 * MAX(chapterNumber) over the whole history). The only report that does not
 * append is a consecutive duplicate: when the manga's most recent event is
 * the same chapter within DEDUP_WINDOW_MS, that event is returned instead
 * (created: false).
 */
export async function recordReadingEvent(
  input: RecordReadingEventInput,
): Promise<{ manga: Manga; event: ReadingEvent; created: boolean }> {
  const normalizedSlug = normalizeSlug(input.mangaName);
  const sourceDomain = new URL(input.sourceUrl).hostname;
  const chapterNumber = parseChapterNumber(input.chapterLabel);

  const manga = await prisma.manga.upsert({
    where: { normalizedSlug },
    create: { canonicalName: input.mangaName, normalizedSlug },
    update: {},
  });

  const latest = await prisma.readingEvent.findFirst({
    where: { mangaId: manga.id },
    orderBy: { readAt: "desc" },
  });
  if (
    latest &&
    isSameChapter(latest, chapterNumber, input.chapterLabel) &&
    Date.now() - latest.readAt.getTime() < DEDUP_WINDOW_MS
  ) {
    return { manga, event: latest, created: false };
  }

  const event = await prisma.readingEvent.create({
    data: {
      mangaId: manga.id,
      chapterLabel: input.chapterLabel,
      chapterNumber,
      sourceUrl: input.sourceUrl,
      sourceDomain,
    },
  });

  return { manga, event, created: true };
}

// The parsed number is the chapter's identity when both sides have one
// ("Cap. 49" and "Chapter 49" are the same chapter); the raw label is the
// fallback for unparseable chapters ("Especial").
function isSameChapter(
  latest: ReadingEvent,
  chapterNumber: number | null,
  chapterLabel: string,
): boolean {
  if (latest.chapterNumber !== null && chapterNumber !== null) {
    return latest.chapterNumber === chapterNumber;
  }
  return latest.chapterLabel === chapterLabel;
}
