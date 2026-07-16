import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  mangaSchema,
  readingEventSchema,
  toEventDto,
  toMangaDto,
} from "../../lib/schemas";
import { recordReadingEvent } from "./events.service";

const createEventBodySchema = z
  .object({
    mangaName: z.string().trim().min(1),
    chapterLabel: z.string().trim().min(1),
    sourceUrl: z.url(),
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
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

export const eventsRoutes = new OpenAPIHono({ defaultHook }).openapi(
  postEventRoute,
  async (c) => {
    const body = c.req.valid("json");
    const { manga, event } = await recordReadingEvent(body);
    return c.json({ manga: toMangaDto(manga), event: toEventDto(event) }, 201);
  },
);
