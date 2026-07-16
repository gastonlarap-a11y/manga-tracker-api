import { z } from "@hono/zod-openapi";

export const mangaSchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
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

// Structurally-typed params keep lib free of imports from src/generated.
export function toMangaDto(manga: {
  id: string;
  canonicalName: string;
  normalizedSlug: string;
  createdAt: Date;
}): MangaDto {
  return {
    id: manga.id,
    canonicalName: manga.canonicalName,
    normalizedSlug: manga.normalizedSlug,
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
