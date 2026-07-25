import { prisma } from "../../db/client";
import type { Manga, ReadingEvent } from "../../generated/prisma/client";
import { normalizeSlug, parseChapterNumber } from "../../lib/normalize";
import { publishLibraryChanged } from "./events.bus";

export interface RecordReadingEventInput {
  mangaName: string;
  chapterLabel: string;
  sourceUrl: string;
  coverUrl?: string;
}

/**
 * Records one reading. The server derives slug, domain and chapter number —
 * clients are never trusted with them. Events are append-only: nothing is
 * ever updated or deleted, and a LOWER but unseen chapter still inserts
 * (that is exactly the "site changed servers" case; the library projection
 * takes MAX(chapterNumber) over the whole history). The one report that does
 * not append: a chapter already present anywhere in the manga's history —
 * re-reading or reloading an existing chapter returns its stored event
 * (created: false). The optional coverUrl (og:image captured by the
 * extension) is persisted only while the manga has none (first cover wins;
 * manual covers set from the dashboard are never clobbered), even on
 * deduplicated reports.
 */
export async function recordReadingEvent(
  input: RecordReadingEventInput,
): Promise<{ manga: Manga; event: ReadingEvent; created: boolean }> {
  const normalizedSlug = normalizeSlug(input.mangaName);
  const sourceDomain = new URL(input.sourceUrl).hostname;
  const chapterNumber = parseChapterNumber(input.chapterLabel);

  let manga = await prisma.manga.upsert({
    where: { normalizedSlug },
    create: { canonicalName: input.mangaName, normalizedSlug },
    update: {},
  });

  // First cover wins: an already-stored cover (automatic or user-set) is
  // never overwritten by later readings — clearing it from the dashboard is
  // the way to let a new one in.
  let coverChanged = false;
  if (input.coverUrl && manga.coverUrl === null) {
    manga = await prisma.manga.update({
      where: { id: manga.id },
      data: { coverUrl: input.coverUrl, coverVersion: { increment: 1 } },
    });
    coverChanged = true;
  }

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
    if (coverChanged) {
      publishLibraryChanged();
    }
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

  publishLibraryChanged();
  return { manga, event, created: true };
}
