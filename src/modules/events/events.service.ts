import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { normalizeSlug, parseChapterNumber } from "../../lib/normalize";

export interface RecordReadingEventInput {
  mangaName: string;
  chapterLabel: string;
  sourceUrl: string;
}

/**
 * Records one reading. The server derives slug, domain and chapter number —
 * clients are never trusted with them. Events are append-only: this ALWAYS
 * inserts, even when the chapter is lower than the current maximum (that is
 * exactly the "site changed servers" case); progress never regresses because
 * the library projection takes MAX(chapterNumber) over the whole history.
 */
export async function recordReadingEvent(
  input: RecordReadingEventInput,
): Promise<{ manga: Manga; event: ReadingEvent }> {
  const normalizedSlug = normalizeSlug(input.mangaName);
  const sourceDomain = new URL(input.sourceUrl).hostname;
  const chapterNumber = parseChapterNumber(input.chapterLabel);

  const manga = await prisma.manga.upsert({
    where: { normalizedSlug },
    create: { canonicalName: input.mangaName, normalizedSlug },
    update: {},
  });

  const event = await prisma.readingEvent.create({
    data: {
      mangaId: manga.id,
      chapterLabel: input.chapterLabel,
      chapterNumber,
      sourceUrl: input.sourceUrl,
      sourceDomain,
    },
  });

  return { manga, event };
}
