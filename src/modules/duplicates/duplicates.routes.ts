import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook } from "../../lib/http";
import { mangaSchema, toMangaDto } from "../../lib/schemas";
import { findDuplicatePairs } from "./duplicates.service";

export const duplicatePairSchema = z
  .object({
    a: mangaSchema,
    b: mangaSchema,
    similarity: z.number().min(0).max(1),
  })
  .openapi("DuplicatePair");

const getDuplicatesRoute = createRoute({
  method: "get",
  path: "/duplicates",
  tags: ["duplicates"],
  responses: {
    200: {
      description:
        "Suspected duplicate pairs (detection only, sorted by similarity)",
      content: {
        "application/json": { schema: z.array(duplicatePairSchema) },
      },
    },
  },
});

export const duplicatesRoutes = new OpenAPIHono({ defaultHook }).openapi(
  getDuplicatesRoute,
  async (c) => {
    const pairs = await findDuplicatePairs();
    return c.json(
      pairs.map((pair) => ({
        a: toMangaDto(pair.a),
        b: toMangaDto(pair.b),
        similarity: pair.similarity,
      })),
      200,
    );
  },
);
