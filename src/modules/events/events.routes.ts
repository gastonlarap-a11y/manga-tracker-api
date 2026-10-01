import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { defaultHook, errorSchema } from "../../lib/http";
import { isSiteNameTitle } from "../../lib/normalize";
import {
  mangaSchema,
  readingEventSchema,
  toEventDto,
  toMangaDto,
} from "../../lib/schemas";
import { subscribeLibraryChanges } from "./events.bus";
import { recordReadingEvent } from "./events.service";

/** How far past this machine's clock a reported readAt may be. See below. */
const MAX_CLOCK_SLACK_MS = 60_000;

const createEventBodySchema = z
  .object({
    mangaName: z.string().trim().min(1),
    chapterLabel: z.string().trim().min(1),
    sourceUrl: z.url(),
    coverUrl: z.url().optional(),
    // The series page this chapter belongs to, when the site exposes one. The
    // server derives the stored identity key from it; the raw URL is not kept.
    seriesUrl: z.url().optional(),
    // When the chapter was read, for a report that arrives late: the
    // extension keeps readings the backend was not there for and sends them
    // when it is back. Omitted, it is now — which is every live report.
    readAt: z.iso.datetime({ offset: true }).optional(),
  })
  // A title that is only the site naming itself is an interstitial, not a
  // manga — see isSiteNameTitle. Refused as a malformed request rather than
  // dropped inside the service, because that is what it is: the body describes
  // no reading. Nothing is lost; the page reports again once it really loads.
  .refine((body) => !isSiteNameTitle(body.mangaName, body.sourceUrl), {
    path: ["mangaName"],
    error: "mangaName is the site's own name, not a manga",
  })
  // The client runs on this same machine and shares its clock, so a reading
  // from the future is a bug, not skew — refused before it can sort a card
  // above everything read since. A minute of slack covers the round trip.
  .refine(
    (body) =>
      body.readAt === undefined ||
      Date.parse(body.readAt) <= Date.now() + MAX_CLOCK_SLACK_MS,
    { path: ["readAt"], error: "readAt is in the future" },
  )
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
    // Required, so a body that is not JSON is refused — with a 415 since
    // zod-openapi 1.6 gates the declared media types, with a 400 before.
    // Optional, it skipped validation for another Content-Type and handed the
    // handler `{}`, which it could only answer with a 500.
    body: {
      required: true,
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

// Must stay well under the server's idleTimeout (120s in src/index.ts):
// Bun drops connections that go quiet for longer, even mid-stream.
const HEARTBEAT_MS = 25_000;

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
    const { readAt, ...body } = c.req.valid("json");
    const { manga, event, created } = await recordReadingEvent({
      ...body,
      ...(readAt !== undefined ? { readAt: new Date(readAt) } : {}),
    });
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
