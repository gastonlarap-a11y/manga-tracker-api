import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  mangaSchema,
  mangaStatusSchema,
  readingEventSchema,
  statusFromDb,
  tagsFromJson,
  toEventDto,
  toMangaDto,
} from "../../lib/schemas";
import {
  deleteManga,
  fetchMangaCover,
  getLibrary,
  getMangaHistory,
  updateManga,
} from "./library.service";

export const libraryEntrySchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
    coverUrl: z.string().nullable(),
    status: mangaStatusSchema,
    tags: z.array(z.string()),
    reachedChapter: z
      .object({ number: z.number(), label: z.string() })
      .nullable(),
    lastActivity: z
      .object({ readAt: z.iso.datetime(), chapterLabel: z.string() })
      .nullable(),
    lastSourceUrl: z.string().nullable(),
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
  .object({
    canonicalName: z.string().trim().min(1).optional(),
    status: mangaStatusSchema.optional(),
    tags: z.array(z.string().trim().min(1)).optional(),
    // string = set a manual cover; null = clear it (the next reading refills)
    coverUrl: z.url().nullable().optional(),
  })
  .refine(
    (body) =>
      body.canonicalName !== undefined ||
      body.status !== undefined ||
      body.tags !== undefined ||
      body.coverUrl !== undefined,
    { message: "At least one field must be provided" },
  )
  .openapi("UpdateMangaBody");

const getLibraryRoute = createRoute({
  method: "get",
  path: "/library",
  tags: ["library"],
  request: { query: libraryQuerySchema },
  responses: {
    200: {
      description:
        "Library projection, one entry per manga, most recently read first",
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
      description:
        "Manual corrections applied (name, status and/or tags; normalizedSlug untouched)",
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

const getCoverRoute = createRoute({
  method: "get",
  path: "/mangas/{id}/cover",
  tags: ["library"],
  request: { params: mangaParamsSchema },
  responses: {
    200: {
      description:
        "The manga's cover image, proxied past hotlink-protected CDNs",
      content: {
        "image/*": { schema: z.string().openapi({ format: "binary" }) },
      },
    },
    404: {
      description: "Manga not found, no cover set, or upstream unavailable",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const deleteMangaRoute = createRoute({
  method: "delete",
  path: "/mangas/{id}",
  tags: ["library"],
  request: { params: mangaParamsSchema },
  responses: {
    204: {
      description: "Manga and its whole history deleted (explicit user action)",
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
        status: statusFromDb(entry.status),
        tags: tagsFromJson(entry.tags),
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
    const body = c.req.valid("json");
    const manga = await updateManga(id, body);
    if (!manga) {
      return c.json({ error: "Manga not found" }, 404);
    }
    return c.json(toMangaDto(manga), 200);
  })
  .openapi(getCoverRoute, async (c) => {
    const { id } = c.req.valid("param");
    const cover = await fetchMangaCover(id);
    if (!cover) {
      return c.json({ error: "Cover not available" }, 404);
    }
    return c.body(cover.body, 200, {
      "Content-Type": cover.contentType,
      // The dashboard busts this with a ?v= derived from coverUrl, so a long
      // browser cache is safe even when the user changes the cover.
      "Cache-Control": "public, max-age=86400",
    });
  })
  .openapi(deleteMangaRoute, async (c) => {
    const { id } = c.req.valid("param");
    const deleted = await deleteManga(id);
    if (!deleted) {
      return c.json({ error: "Manga not found" }, 404);
    }
    return c.body(null, 204);
  });
