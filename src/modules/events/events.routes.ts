import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  mangaSchema,
  readingEventSchema,
  toEventDto,
  toMangaDto,
} from "../../lib/schemas";
import { subscribeLibraryChanges } from "./events.bus";
import { recordReadingEvent } from "./events.service";

const createEventBodySchema = z
  .object({
    mangaName: z.string().trim().min(1),
    chapterLabel: z.string().trim().min(1),
    sourceUrl: z.url(),
    coverUrl: z.url().optional(),
  })
  .openapi("CreateEventBody");

const createEventResponseSchema = z
  .object({
    manga: mangaSchema,
    event: readingEventSchema,
  })
  .openapi("CreateEventResponse");

const postEventRoute = createRoute({
  method: "post",
  path: "/events",
  tags: ["events"],
  request: {
    body: {
      content: { "application/json": { schema: createEventBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Reading event recorded",
      content: { "application/json": { schema: createEventResponseSchema } },
    },
    200: {
      description:
        "Chapter already recorded for this manga; the existing event is returned",
      content: { "application/json": { schema: createEventResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const HEARTBEAT_MS = 30_000;

const streamRoute = createRoute({
  method: "get",
  path: "/events/stream",
  tags: ["events"],
  responses: {
    200: {
      description:
        "Server-sent events: emits `library-changed` whenever the library projection changes (new reading, rename, status/tags edit, delete); `ping` heartbeats keep the connection alive",
    },
  },
});

export const eventsRoutes = new OpenAPIHono({ defaultHook })
  .openapi(postEventRoute, async (c) => {
    const body = c.req.valid("json");
    const { manga, event, created } = await recordReadingEvent(body);
    const payload = { manga: toMangaDto(manga), event: toEventDto(event) };
    return created ? c.json(payload, 201) : c.json(payload, 200);
  })
  .openapi(streamRoute, (c) =>
    streamSSE(c, async (stream) => {
      let active = true;
      const unsubscribe = subscribeLibraryChanges(() => {
        void stream.writeSSE({
          event: "library-changed",
          data: String(Date.now()),
        });
      });
      stream.onAbort(() => {
        active = false;
        unsubscribe();
      });
      while (active) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(HEARTBEAT_MS);
      }
    }),
  );
