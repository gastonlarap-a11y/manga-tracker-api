import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { duplicatePairSchema, duplicatesRoutes } from "./duplicates.routes";

const duplicatesResponseSchema = z.array(duplicatePairSchema);

beforeEach(async () => {
  await prisma.manga.deleteMany();
});

describe("GET /duplicates", () => {
  it("returns exactly the near-duplicate pair above the threshold", async () => {
    await prisma.manga.createMany({
      data: [
        { canonicalName: "Solo Leveling", normalizedSlug: "solo-leveling" },
        { canonicalName: "Solo Levelling", normalizedSlug: "solo-levelling" },
        { canonicalName: "One Piece", normalizedSlug: "one-piece" },
      ],
    });

    const res = await duplicatesRoutes.request("/duplicates");
    expect(res.status).toBe(200);
    const pairs = duplicatesResponseSchema.parse(await res.json());

    expect(pairs).toHaveLength(1);
    const pair = pairs[0];
    expect(pair.similarity).toBeGreaterThanOrEqual(0.85);
    expect(pair.similarity).toBeCloseTo(1 - 1 / 14, 4);
    expect([pair.a.normalizedSlug, pair.b.normalizedSlug].toSorted()).toEqual([
      "solo-leveling",
      "solo-levelling",
    ]);
  });

  it("returns an empty list when nothing is similar", async () => {
    await prisma.manga.createMany({
      data: [
        { canonicalName: "One Piece", normalizedSlug: "one-piece" },
        { canonicalName: "Berserk", normalizedSlug: "berserk" },
      ],
    });

    const pairs = duplicatesResponseSchema.parse(
      await (await duplicatesRoutes.request("/duplicates")).json(),
    );
    expect(pairs).toEqual([]);
  });

  it("returns an empty list on an empty library", async () => {
    const pairs = duplicatesResponseSchema.parse(
      await (await duplicatesRoutes.request("/duplicates")).json(),
    );
    expect(pairs).toEqual([]);
  });
});
