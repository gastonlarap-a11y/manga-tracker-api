import { beforeEach, describe, expect, it } from "bun:test";
import { z } from "@hono/zod-openapi";
import { prisma } from "../../db/client";
import { mangaSchema } from "../../lib/schemas";
import { duplicatePairSchema, duplicatesRoutes } from "./duplicates.routes";

const duplicatesResponseSchema = z.array(duplicatePairSchema);

// The pair that made the same series show up as two cards in the library: two
// sites, two translations of one Japanese title.
const DRAGON_A = {
  canonicalName: "Callate dragona malvada, ya no quiero criar hijos contigo",
  normalizedSlug: "callate-dragona-malvada-ya-no-quiero-criar-hijos-contigo",
};
const DRAGON_B = {
  canonicalName: "Cállate, malvado dragón, ya no quiero criar hijos contigo",
  normalizedSlug: "callate-malvado-dragon-ya-no-quiero-criar-hijos-contigo",
};

beforeEach(async () => {
  await prisma.duplicateDismissal.deleteMany();
  await prisma.manga.deleteMany();
});

async function listDuplicates() {
  const res = await duplicatesRoutes.request("/duplicates");
  expect(res.status).toBe(200);
  return duplicatesResponseSchema.parse(await res.json());
}

function postJson(path: string, body: unknown) {
  return duplicatesRoutes.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /duplicates", () => {
  it("finds the reordered translation that whole-string edit distance missed", async () => {
    await prisma.manga.createMany({
      data: [
        DRAGON_A,
        DRAGON_B,
        { canonicalName: "Berserk", normalizedSlug: "berserk" },
      ],
    });

    const pairs = await listDuplicates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].similarity).toBeGreaterThanOrEqual(0.92);
    expect(pairs[0].reasons).toContain("tokens");
  });

  it("still catches a one-letter typo", async () => {
    await prisma.manga.createMany({
      data: [
        { canonicalName: "Solo Leveling", normalizedSlug: "solo-leveling" },
        { canonicalName: "Solo Levelling", normalizedSlug: "solo-levelling" },
      ],
    });

    const pairs = await listDuplicates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].similarity).toBeCloseTo(1 - 1 / 14, 4);
  });

  it("flags a suspected sequel instead of hiding it", async () => {
    await prisma.manga.createMany({
      data: [
        { canonicalName: "Dr. Stone", normalizedSlug: "dr-stone" },
        { canonicalName: "Dr. Stone 2", normalizedSlug: "dr-stone-2" },
      ],
    });

    const pairs = await listDuplicates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sequelSuspicion).toBe(true);
  });

  it("pairs two unrelated titles that share a cover", async () => {
    // The signal that does not care how the titles read.
    await prisma.manga.createMany({
      data: [
        {
          canonicalName: "Shut Up, Evil Dragon",
          normalizedSlug: "shut-up-evil-dragon",
          coverUrl: "https://cdn.example.com/dragon.jpg",
        },
        {
          canonicalName: "Cállate dragona",
          normalizedSlug: "callate-dragona",
          coverUrl: "https://cdn.example.com/dragon.jpg",
        },
      ],
    });

    const pairs = await listDuplicates();
    expect(pairs).toHaveLength(1);
    expect(pairs[0].reasons).toEqual(["cover"]);
    expect(pairs[0].similarity).toBe(1);
  });

  it("does not pair two mangas that both lack a cover", async () => {
    await prisma.manga.createMany({
      data: [
        { canonicalName: "One Piece", normalizedSlug: "one-piece" },
        { canonicalName: "Berserk", normalizedSlug: "berserk" },
      ],
    });
    expect(await listDuplicates()).toEqual([]);
  });

  it("returns an empty list on an empty library", async () => {
    expect(await listDuplicates()).toEqual([]);
  });

  it("ignores mangas already merged and soft-deleted ones", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    await prisma.manga.create({
      data: { ...DRAGON_B, mergedIntoSlug: a.normalizedSlug },
    });
    expect(await listDuplicates()).toEqual([]);

    await prisma.manga.updateMany({ data: { mergedIntoSlug: null } });
    await prisma.manga.update({
      where: { normalizedSlug: DRAGON_B.normalizedSlug },
      data: { deletedAt: new Date() },
    });
    expect(await listDuplicates()).toEqual([]);
  });
});

describe("POST /duplicates/dismiss", () => {
  it("keeps the rejected pair out of every later report", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    expect(await listDuplicates()).toHaveLength(1);

    const res = await postJson("/duplicates/dismiss", { idA: a.id, idB: b.id });
    expect(res.status).toBe(204);
    expect(await listDuplicates()).toEqual([]);
  });

  it("dismisses the pair regardless of the order the ids come in", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });

    await postJson("/duplicates/dismiss", { idA: b.id, idB: a.id });
    const rows = await prisma.duplicateDismissal.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].slugA < rows[0].slugB).toBe(true);
  });

  it("is idempotent", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });

    await postJson("/duplicates/dismiss", { idA: a.id, idB: b.id });
    const second = await postJson("/duplicates/dismiss", {
      idA: a.id,
      idB: b.id,
    });
    expect(second.status).toBe(204);
    expect(await prisma.duplicateDismissal.count()).toBe(1);
  });

  it("404s on an unknown manga", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const res = await postJson("/duplicates/dismiss", {
      idA: a.id,
      idB: "nope",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /duplicates/merge", () => {
  it("turns the absorbed manga into an alias without touching a single event", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    await prisma.readingEvent.createMany({
      data: [
        {
          mangaId: a.id,
          chapterLabel: "Cap. 1",
          chapterNumber: 1,
          sourceUrl: "https://a.example/1",
          sourceDomain: "a.example",
        },
        {
          mangaId: b.id,
          chapterLabel: "Capítulo 2",
          chapterNumber: 2,
          sourceUrl: "https://b.example/2",
          sourceDomain: "b.example",
        },
      ],
    });
    const eventsBefore = await prisma.readingEvent.findMany({
      orderBy: { id: "asc" },
    });

    const res = await postJson("/duplicates/merge", {
      canonicalId: a.id,
      aliasId: b.id,
    });
    expect(res.status).toBe(200);

    const alias = await prisma.manga.findUniqueOrThrow({ where: { id: b.id } });
    expect(alias.mergedIntoSlug).toBe(a.normalizedSlug);

    // The whole point: append-only survived the merge.
    expect(
      await prisma.readingEvent.findMany({ orderBy: { id: "asc" } }),
    ).toEqual(eventsBefore);
    expect(await listDuplicates()).toEqual([]);
  });

  it("merges two titles with nothing in common — the manual path from the dashboard", async () => {
    const spanish = await prisma.manga.create({
      data: {
        canonicalName: "Cállate dragona",
        normalizedSlug: "callate-dragona",
      },
    });
    const english = await prisma.manga.create({
      data: {
        canonicalName: "Shut Up, Evil Dragon",
        normalizedSlug: "shut-up-evil-dragon",
      },
    });

    const res = await postJson("/duplicates/merge", {
      canonicalId: spanish.id,
      aliasId: english.id,
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: english.id } }))
        .mergedIntoSlug,
    ).toBe("callate-dragona");
  });

  it("flattens an existing chain instead of nesting it", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    const c = await prisma.manga.create({
      data: { canonicalName: "Dragona", normalizedSlug: "dragona-mala" },
    });

    // c -> b, then b -> a: c must end up pointing straight at a.
    await postJson("/duplicates/merge", { canonicalId: b.id, aliasId: c.id });
    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });

    const rows = await prisma.manga.findMany({
      where: { id: { in: [b.id, c.id] } },
    });
    expect(rows.map((row) => row.mergedIntoSlug)).toEqual([
      a.normalizedSlug,
      a.normalizedSlug,
    ]);
  });

  it("accepts an alias as either side and resolves it to its group", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    const c = await prisma.manga.create({
      data: { canonicalName: "Dragona", normalizedSlug: "dragona-mala" },
    });
    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });

    // b is already an alias of a; merging c into b must land c on a.
    const res = await postJson("/duplicates/merge", {
      canonicalId: b.id,
      aliasId: c.id,
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: c.id } }))
        .mergedIntoSlug,
    ).toBe(a.normalizedSlug);
  });

  it("is idempotent when both ids already share a group", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });

    const res = await postJson("/duplicates/merge", {
      canonicalId: a.id,
      aliasId: b.id,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alias: null });
  });

  it("cannot merge a manga into itself", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const res = await postJson("/duplicates/merge", {
      canonicalId: a.id,
      aliasId: a.id,
    });
    expect(res.status).toBe(200);
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: a.id } }))
        .mergedIntoSlug,
    ).toBeNull();
  });

  it("gives the survivor the cover it lacked and the union of both tag sets", async () => {
    const a = await prisma.manga.create({
      data: { ...DRAGON_A, tags: '["shonen"]' },
    });
    const b = await prisma.manga.create({
      data: {
        ...DRAGON_B,
        coverUrl: "https://cdn.example.com/dragon.jpg",
        tags: '["isekai","shonen"]',
      },
    });

    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });
    const canonical = await prisma.manga.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(canonical.coverUrl).toBe("https://cdn.example.com/dragon.jpg");
    expect(JSON.parse(canonical.tags)).toEqual(["shonen", "isekai"]);
  });

  it("revives a deleted survivor rather than hiding a manga that is being read", async () => {
    const a = await prisma.manga.create({
      data: { ...DRAGON_A, deletedAt: new Date() },
    });
    const b = await prisma.manga.create({ data: DRAGON_B });

    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: a.id } })).deletedAt,
    ).toBeNull();
  });

  it("404s on an unknown manga", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const res = await postJson("/duplicates/merge", {
      canonicalId: a.id,
      aliasId: "nope",
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /duplicates/unmerge", () => {
  it("gives the alias its card back", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const b = await prisma.manga.create({ data: DRAGON_B });
    await postJson("/duplicates/merge", { canonicalId: a.id, aliasId: b.id });

    const res = await postJson("/duplicates/unmerge", { id: b.id });
    expect(res.status).toBe(200);
    expect(mangaSchema.parse(await res.json()).mergedIntoSlug).toBeNull();
    expect(await listDuplicates()).toHaveLength(1);
  });

  it("400s on a manga that was never merged", async () => {
    const a = await prisma.manga.create({ data: DRAGON_A });
    const res = await postJson("/duplicates/unmerge", { id: a.id });
    expect(res.status).toBe(400);
  });

  it("404s on an unknown manga", async () => {
    const res = await postJson("/duplicates/unmerge", { id: "nope" });
    expect(res.status).toBe(404);
  });
});
