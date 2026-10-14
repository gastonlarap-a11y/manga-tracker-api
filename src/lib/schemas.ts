import { z } from "@hono/zod-openapi";

// on_hold: still followed, set aside for now — the author on hiatus, or
// waiting for chapters to pile up. Same meaning as MAL's "On Hold" and
// AniList's PAUSED; "hiatus" there is the work's publication status, which
// this app cannot know without a catalogue lookup.
export const mangaStatusSchema = z
  .enum(["reading", "on_hold", "completed", "dropped"])
  .openapi("MangaStatus");
export type MangaStatus = z.infer<typeof mangaStatusSchema>;

/**
 * Every status that is not reading. Filtering "reading" as "none of these"
 * rather than as an exact match keeps a status this build does not know —
 * one a newer release wrote and sync carried here — where statusFromDb and
 * the counts put it.
 */
export const NOT_READING: readonly MangaStatus[] =
  mangaStatusSchema.options.filter((status) => status !== "reading");

export const mangaSchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
    coverUrl: z.string().nullable(),
    // Bumped on every cover mutation; clients cache-bust /cover with it.
    coverVersion: z.number().int(),
    // True once cover bytes are stored locally; the extension heals covers
    // whose bytes are still pending.
    hasStoredCover: z.boolean(),
    status: mangaStatusSchema,
    tags: z.array(z.string()),
    createdAt: z.iso.datetime(),
    // Non-null means this manga was merged into another one and no longer owns
    // a card of its own; the value is the canonical's normalizedSlug.
    mergedIntoSlug: z.string().nullable(),
  })
  .openapi("Manga");
export type MangaDto = z.infer<typeof mangaSchema>;

export const readingEventSchema = z
  .object({
    id: z.string(),
    mangaId: z.string(),
    chapterLabel: z.string(),
    chapterNumber: z.number().nullable(),
    sourceUrl: z.string(),
    sourceDomain: z.string(),
    readAt: z.iso.datetime(),
  })
  .openapi("ReadingEvent");
export type ReadingEventDto = z.infer<typeof readingEventSchema>;

// Tags live in SQLite as a JSON string; a corrupt value degrades to [] rather
// than breaking every listing.
export function tagsFromJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

// The DB column is a plain string; anything unexpected reads as "reading".
// Read, not rewritten: the stored value is kept as sync delivered it, so a
// status from a newer release survives this one (see sync.mapper's asStatus).
export function statusFromDb(raw: string): MangaStatus {
  const parsed = mangaStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : "reading";
}

interface MangaDtoFields {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  coverVersion: number;
  status: string;
  tags: string;
  createdAt: Date;
  mergedIntoSlug: string | null;
}

/**
 * A manga row read with its cover bytes, or read without them and told
 * whether there are any — which is how every list reads it now, since those
 * bytes are a cover's worth of data per row.
 */
export type MangaDtoSource = MangaDtoFields &
  ({ coverImage: Uint8Array | null } | { hasStoredCover: boolean });

// Structurally-typed params keep lib free of imports from src/generated.
export function toMangaDto(manga: MangaDtoSource): MangaDto {
  return {
    id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
    coverUrl: manga.coverUrl,
    coverVersion: manga.coverVersion,
    hasStoredCover:
      "hasStoredCover" in manga
        ? manga.hasStoredCover
        : manga.coverImage !== null,
    status: statusFromDb(manga.status),
    tags: tagsFromJson(manga.tags),
    createdAt: manga.createdAt.toISOString(),
    mergedIntoSlug: manga.mergedIntoSlug,
  };
}

export function toEventDto(event: {
  id: string;
  mangaId: string;
  chapterLabel: string;
  chapterNumber: number | null;
  sourceUrl: string;
  sourceDomain: string;
  readAt: Date;
}): ReadingEventDto {
  return {
    id: event.id,
    mangaId: event.mangaId,
    chapterLabel: event.chapterLabel,
    chapterNumber: event.chapterNumber,
    sourceUrl: event.sourceUrl,
    sourceDomain: event.sourceDomain,
    readAt: event.readAt.toISOString(),
  };
}
