import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { isTimeZone } from "../../lib/calendar-day";
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
  getActivity,
  getLibrary,
  getMangaHistory,
  MAX_COVER_IMAGE_BYTES,
  storeMangaCoverImage,
  updateManga,
} from "./library.service";

export const libraryEntrySchema = z
  .object({
    id: z.string(),
    canonicalName: z.string(),
    normalizedSlug: z.string(),
    coverUrl: z.string().nullable(),
    coverVersion: z.number().int(),
    hasStoredCover: z.boolean(),
    status: mangaStatusSchema,
    tags: z.array(z.string()),
    reachedChapter: z
      .object({ number: z.number(), label: z.string() })
      .nullable(),
    lastActivity: z
      .object({ readAt: z.iso.datetime(), chapterLabel: z.string() })
      .nullable(),
    lastSourceUrl: z.string().nullable(),
    // Distinct chapters read, not event rows: a chapter read on two merged
    // sites counts once.
    readCount: z.number().int(),
    sourceDomains: z.array(z.string()),
    // How many other mangas were merged into this card; 0 for an untouched one.
    aliasCount: z.number().int(),
  })
  .openapi("LibraryEntry");

export const historyEventSchema = readingEventSchema
  .extend({
    // Other domains where this same chapter was read. Non-empty only after a
    // merge: the chapter is listed once, and this says where else it was read.
    alsoReadOn: z.array(z.string()),
  })
  .openapi("HistoryEvent");

export const mangaHistorySchema = z
  .object({
    manga: mangaSchema,
    // The mangas merged into this one. Empty for an untouched card; each entry
    // can be detached again with POST /duplicates/unmerge.
    aliases: z.array(mangaSchema),
    events: z.array(historyEventSchema),
  })
  .openapi("MangaHistory");

const libraryQuerySchema = z
  .object({
    domain: z.string().optional(),
    since: z.iso.datetime().optional(),
  })
  .openapi("LibraryQuery");

export const libraryActivitySchema = z
  .object({
    timeZone: z.string(),
    // Oldest first, one entry per calendar day of the window, zeros included.
    days: z.array(
      z.object({
        date: z.iso.date(),
        chapters: z.number().int().nonnegative(),
      }),
    ),
  })
  .openapi("LibraryActivity");

const activityQuerySchema = z
  .object({
    // 84 = twelve full weeks, what the dashboard's heatmap shows. Capped at a
    // year and a week so a query cannot ask the server to format forever.
    days: z.coerce.number().int().min(7).max(371).default(84),
    // The reader's zone, from the dashboard. Without it, the server's own —
    // which on the machine it runs on is usually the same one.
    tz: z
      .string()
      .refine(isTimeZone, { message: "Unknown time zone" })
      .optional(),
  })
  .openapi("LibraryActivityQuery");

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

const getActivityRoute = createRoute({
  method: "get",
  path: "/library/activity",
  tags: ["library"],
  request: { query: activityQuerySchema },
  responses: {
    200: {
      description:
        "Distinct chapters read per calendar day in the given time zone, oldest first",
      content: { "application/json": { schema: libraryActivitySchema } },
    },
    400: {
      description: "Invalid query (days out of range, or an unknown time zone)",
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
    // Required so a non-JSON body is a 400, not {} and a 500: see events.routes.ts.
    body: {
      required: true,
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

const putCoverImageRoute = createRoute({
  method: "put",
  path: "/mangas/{id}/cover-image",
  tags: ["library"],
  middleware: [
    bodyLimit({
      maxSize: MAX_COVER_IMAGE_BYTES,
      onError: (c) => c.json({ error: "Cover image too large" }, 413),
    }),
  ] as const,
  request: {
    params: mangaParamsSchema,
    body: {
      content: {
        "image/*": { schema: z.string().openapi({ format: "binary" }) },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description:
        "Cover bytes stored locally (captured by the extension in the browser)",
      content: { "application/json": { schema: mangaSchema } },
    },
    400: {
      description: "Body is not an image or is empty",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "Manga not found",
      content: { "application/json": { schema: errorSchema } },
    },
    413: {
      description: "Image exceeds the size cap",
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
  .openapi(getActivityRoute, async (c) => {
    const query = c.req.valid("query");
    const timeZone =
      query.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const days = await getActivity({ days: query.days, timeZone });
    return c.json({ timeZone, days }, 200);
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
        aliases: history.aliases.map(toMangaDto),
        events: history.events.map((event) => ({
          ...toEventDto(event),
          alsoReadOn: event.alsoReadOn,
        })),
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
  .openapi(putCoverImageRoute, async (c) => {
    const { id } = c.req.valid("param");
    // zod-openapi only validates JSON bodies; the image/* schema above is
    // documentation, so the handler checks the binary body itself.
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.startsWith("image/")) {
      return c.json({ error: "Content-Type must be image/*" }, 400);
    }
    const bytes = await c.req.arrayBuffer();
    if (bytes.byteLength === 0) {
      return c.json({ error: "Empty body" }, 400);
    }
    const manga = await storeMangaCoverImage(id, bytes, contentType);
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
