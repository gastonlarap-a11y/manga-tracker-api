import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook, errorSchema } from "../../lib/http";
import { mangaSchema, toMangaDto } from "../../lib/schemas";
import {
  dismissDuplicatePair,
  findDuplicatePairs,
  mergeMangas,
  unmergeManga,
} from "./duplicates.service";

export const duplicatePairSchema = z
  .object({
    a: mangaSchema,
    b: mangaSchema,
    similarity: z.number().min(0).max(1),
    // Why the pair was flagged, so the dashboard can say it out loud instead of
    // showing a bare percentage: "tokens", "edit-distance", "containment",
    // "cover".
    reasons: z.array(z.string()),
    // True when the leftover words look like a season or a spin-off. The pair
    // is still shown, but merging it is a decision only the user can make.
    sequelSuspicion: z.boolean(),
  })
  .openapi("DuplicatePair");

const getDuplicatesRoute = createRoute({
  method: "get",
  path: "/duplicates",
  tags: ["duplicates"],
  responses: {
    200: {
      description: "Suspected duplicate pairs, sorted by similarity",
      content: {
        "application/json": { schema: z.array(duplicatePairSchema) },
      },
    },
  },
});

const mergeBodySchema = z
  .object({
    /** The manga that keeps its card, name, status and history. */
    canonicalId: z.string().min(1),
    /** The manga absorbed into it. Its events are never moved. */
    aliasId: z.string().min(1),
  })
  .openapi("MergeMangasBody");

export const mergeResultSchema = z
  .object({
    canonical: mangaSchema,
    /** Absent when the two ids already belonged to the same group. */
    alias: mangaSchema.nullable(),
  })
  .openapi("MergeResult");

const mergeRoute = createRoute({
  method: "post",
  path: "/duplicates/merge",
  tags: ["duplicates"],
  request: {
    body: {
      content: { "application/json": { schema: mergeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The two mangas now share one card",
      content: { "application/json": { schema: mergeResultSchema } },
    },
    400: {
      description: "Invalid body",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "One of the mangas does not exist",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const unmergeBodySchema = z
  .object({ id: z.string().min(1) })
  .openapi("UnmergeMangaBody");

const unmergeRoute = createRoute({
  method: "post",
  path: "/duplicates/unmerge",
  tags: ["duplicates"],
  request: {
    body: {
      content: { "application/json": { schema: unmergeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "The manga owns its card again, with its history intact",
      content: { "application/json": { schema: mangaSchema } },
    },
    400: {
      description: "Invalid body, or the manga was not merged into anything",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "The manga does not exist",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const dismissBodySchema = z
  .object({ idA: z.string().min(1), idB: z.string().min(1) })
  .openapi("DismissDuplicateBody");

const dismissRoute = createRoute({
  method: "post",
  path: "/duplicates/dismiss",
  tags: ["duplicates"],
  request: {
    body: {
      content: { "application/json": { schema: dismissBodySchema } },
    },
  },
  responses: {
    204: { description: "The pair will not be suggested again" },
    400: {
      description: "Invalid body",
      content: { "application/json": { schema: errorSchema } },
    },
    404: {
      description: "One of the mangas does not exist",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

export const duplicatesRoutes = new OpenAPIHono({ defaultHook })
  .openapi(getDuplicatesRoute, async (c) => {
    const pairs = await findDuplicatePairs();
    return c.json(
      pairs.map((pair) => ({
        a: toMangaDto(pair.a),
        b: toMangaDto(pair.b),
        similarity: pair.similarity,
        reasons: [...pair.reasons],
        sequelSuspicion: pair.sequelSuspicion,
      })),
      200,
    );
  })
  .openapi(mergeRoute, async (c) => {
    const { canonicalId, aliasId } = c.req.valid("json");
    const outcome = await mergeMangas(canonicalId, aliasId);
    switch (outcome.kind) {
      case "not-found":
        return c.json({ error: `Manga ${outcome.id} not found` }, 404);
      // Idempotent on purpose: two clicks from the dashboard, or a merge that
      // already arrived through sync, must not read as an error.
      case "already-merged":
        return c.json(
          { canonical: toMangaDto(outcome.canonical), alias: null },
          200,
        );
      case "merged":
        return c.json(
          {
            canonical: toMangaDto(outcome.canonical),
            alias: toMangaDto(outcome.alias),
          },
          200,
        );
    }
  })
  .openapi(unmergeRoute, async (c) => {
    const { id } = c.req.valid("json");
    const outcome = await unmergeManga(id);
    switch (outcome.kind) {
      case "not-found":
        return c.json({ error: `Manga ${outcome.id} not found` }, 404);
      case "not-merged":
        return c.json({ error: "Manga is not merged into another one" }, 400);
      case "unmerged":
        return c.json(toMangaDto(outcome.manga), 200);
    }
  })
  .openapi(dismissRoute, async (c) => {
    const { idA, idB } = c.req.valid("json");
    const outcome = await dismissDuplicatePair(idA, idB);
    if (outcome.kind === "not-found") {
      return c.json({ error: `Manga ${outcome.id} not found` }, 404);
    }
    return c.body(null, 204);
  });
