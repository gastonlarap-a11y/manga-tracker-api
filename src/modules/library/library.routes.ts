import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  mangaSchema,
  readingEventSchema,
  toEventDto,
  toMangaDto,
} from "../../lib/schemas";
import {
  getLibrary,
  getMangaHistory,
  updateCanonicalName,
} from "./library.service";

export const libraryEntrySchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
    reachedChapter: z
      .object({ number: z.number(), label: z.string() })
      .nullable(),
    lastActivity: z
      .object({ readAt: z.iso.datetime(), chapterLabel: z.string() })
      .nullable(),
    readCount: z.number().int(),
    sourceDomains: z.array(z.string()),
  })
  .openapi("LibraryEntry");

export const mangaHistorySchema = z
  .object({
    manga: mangaSchema,
    events: z.array(readingEventSchema),
  })
  .openapi("MangaHistory");

const libraryQuerySchema = z
  .object({
    domain: z.string().optional(),
    since: z.iso.datetime().optional(),
  })
  .openapi("LibraryQuery");

const mangaParamsSchema = z.object({ id: z.string() });

const updateMangaBodySchema = z
  .object({ canonicalName: z.string().trim().min(1) })
  .openapi("UpdateMangaBody");

const getLibraryRoute = createRoute({
  method: "get",
  path: "/library",
  tags: ["library"],
  request: { query: libraryQuerySchema },
  responses: {
    200: {
      description: "Library projection, one entry per manga",
      content: { "application/json": { schema: z.array(libraryEntrySchema) } },
    },
    400: {
      description: "Invalid query",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const getHistoryRoute = createRoute({
  method: "get",
  path: "/mangas/{id}/history",
  tags: ["library"],
  request: { params: mangaParamsSchema },
  responses: {
    200: {
      description: "Full reading history, most recent first",
      content: { "application/json": { schema: mangaHistorySchema } },
    },
    404: {
      description: "Manga not found",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const putMangaRoute = createRoute({
  method: "put",
  path: "/mangas/{id}",
  tags: ["library"],
  request: {
    params: mangaParamsSchema,
    body: {
      content: { "application/json": { schema: updateMangaBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Canonical name updated (normalizedSlug untouched)",
      content: { "application/json": { schema: mangaSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "Manga not found",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

export const libraryRoutes = new OpenAPIHono({ defaultHook })
  .openapi(getLibraryRoute, async (c) => {
    const query = c.req.valid("query");
    const entries = await getLibrary({
      domain: query.domain,
      since: query.since ? new Date(query.since) : undefined,
    });
    return c.json(
      entries.map((entry) => ({
        ...entry,
        lastActivity: entry.lastActivity
          ? {
              readAt: entry.lastActivity.readAt.toISOString(),
              chapterLabel: entry.lastActivity.chapterLabel,
            }
          : null,
      })),
      200,
    );
  })
  .openapi(getHistoryRoute, async (c) => {
    const { id } = c.req.valid("param");
    const history = await getMangaHistory(id);
    if (!history) {
      return c.json({ error: "Manga not found" }, 404);
    }
    return c.json(
      {
        manga: toMangaDto(history.manga),
        events: history.events.map(toEventDto),
      },
      200,
    );
  })
  .openapi(putMangaRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { canonicalName } = c.req.valid("json");
    const manga = await updateCanonicalName(id, canonicalName);
    if (!manga) {
      return c.json({ error: "Manga not found" }, 404);
    }
    return c.json(toMangaDto(manga), 200);
  });
