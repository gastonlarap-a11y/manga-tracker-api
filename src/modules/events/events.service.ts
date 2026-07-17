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
 * clients are never trusted with them. Events are append-only: nothing is
 * ever updated or deleted, and a LOWER but unseen chapter still inserts
 * (that is exactly the "site changed servers" case; the library projection
 * takes MAX(chapterNumber) over the whole history). The one report that does
 * not append: a chapter already present anywhere in the manga's history —
 * re-reading or reloading an existing chapter returns its stored event
 * (created: false) instead of duplicating it.
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

  // Chapter identity: the parsed number when it exists ("Cap. 49" and
  // "Chapter 49" are the same chapter); the exact label otherwise.
  const existing = await prisma.readingEvent.findFirst({
    where:
      chapterNumber !== null
        ? { mangaId: manga.id, chapterNumber }
        : {
            mangaId: manga.id,
            chapterNumber: null,
            chapterLabel: input.chapterLabel,
          },
    orderBy: { readAt: "desc" },
  });
  if (existing) {
    return { manga, event: existing, created: false };
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
