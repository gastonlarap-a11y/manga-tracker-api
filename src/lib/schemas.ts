import { z } from "@hono/zod-openapi";

export const mangaStatusSchema = z
  .enum(["reading", "completed", "dropped"])
  .openapi("MangaStatus");
export type MangaStatus = z.infer<typeof mangaStatusSchema>;

export const mangaSchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
    coverUrl: z.string().nullable(),
    status: mangaStatusSchema,
    tags: z.array(z.string()),
    createdAt: z.iso.datetime(),
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
export function statusFromDb(raw: string): MangaStatus {
  const parsed = mangaStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : "reading";
}

// Structurally-typed params keep lib free of imports from src/generated.
export function toMangaDto(manga: {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  coverUrl: string | null;
  status: string;
  tags: string;
  createdAt: Date;
}): MangaDto {
  return {
    id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
    coverUrl: manga.coverUrl,
    status: statusFromDb(manga.status),
    tags: tagsFromJson(manga.tags),
    createdAt: manga.createdAt.toISOString(),
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
