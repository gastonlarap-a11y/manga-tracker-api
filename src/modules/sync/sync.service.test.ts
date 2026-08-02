import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { createFakeTarget, type FakeTarget } from "./sync.fake-target";
import { pushToReplica, restoreFromReplica } from "./sync.service";

/**
 * Steady state for most tests: a machine that holds data and whose deletions
 * should reach the replica. The guards that hold deletions back are exercised
 * on their own below.
 */
const push = async (target: FakeTarget, covers = false) => {
  const outcome = await pushToReplica(target, { covers, allowDeletions: true });
  if (outcome.kind !== "pushed") {
    throw new Error(`expected a push, got "${outcome.kind}"`);
  }
  return outcome;
};

const seed = async () => {
  const manga = await prisma.manga.create({
    data: {
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      coverUrl: "https://cdn.example/op.jpg",
      tags: JSON.stringify(["shonen"]),
    },
  });
  await prisma.readingEvent.createMany({
    data: [
      {
        mangaId: manga.id,
        chapterLabel: "Cap. 1",
        chapterNumber: 1,
        sourceUrl: "https://olympusxyz.com/op/1",
        sourceDomain: "olympusxyz.com",
      },
      {
        mangaId: manga.id,
        chapterLabel: "Cap. 2",
        chapterNumber: 2,
        sourceUrl: "https://olympusxyz.com/op/2",
        sourceDomain: "olympusxyz.com",
      },
    ],
  });
  await prisma.siteAdapter.create({
    data: { domain: "olympusxyz.com", titleSelector: "h1.title" },
  });
  return manga;
};

beforeEach(async () => {
  await prisma.manga.deleteMany();
  await prisma.siteAdapter.deleteMany();
});

describe("Sync service: push", () => {
  it("should seed an empty replica with everything already in SQLite", async () => {
    await seed();
    const target = createFakeTarget();

    const result = await push(target);

    expect(result.mangas.upserted).toBe(1);
    expect(result.events.inserted).toBe(2);
    expect(result.adapters.upserted).toBe(1);
    expect(target.mangas.size).toBe(1);
    expect(target.events.size).toBe(2);
    expect(target.adapters.size).toBe(1);
    // Metadata push never carries bytes.
    expect(target.covers.size).toBe(0);
    expect(result.covers).toBe(null);
  });

  it("should translate the library into replica-native shapes", async () => {
    const manga = await seed();
    const target = createFakeTarget();

    await push(target);
    const doc = target.mangas.get(manga.id);

    expect(doc?.normalizedSlug).toBe("one-piece");
    // A real array, not the JSON string SQLite has to store.
    expect(doc?.tags).toEqual(["shonen"]);
    expect(doc?.hasStoredCover).toBe(false);
  });

  it("should move nothing on a second push (idempotent)", async () => {
    await seed();
    const target = createFakeTarget();

    await push(target);
    // The fake throws on a duplicate event insert, so a re-send fails loudly.
    const second = await push(target);

    expect(second.events.inserted).toBe(0);
    expect(second.events.deleted).toBe(0);
    expect(second.mangas.deleted).toBe(0);
    expect(second.adapters.deleted).toBe(0);
    expect(target.calls.eventsInserted).toBe(2);
  });

  it("should push only events appended since the last push", async () => {
    const manga = await seed();
    const target = createFakeTarget();
    await push(target);

    await prisma.readingEvent.create({
      data: {
        mangaId: manga.id,
        chapterLabel: "Cap. 3",
        chapterNumber: 3,
        sourceUrl: "https://olympusxyz.com/op/3",
        sourceDomain: "olympusxyz.com",
      },
    });

    expect((await push(target)).events.inserted).toBe(1);
    expect(target.events.size).toBe(3);
  });

  it("should cascade a local manga deletion into the replica", async () => {
    const manga = await seed();
    const target = createFakeTarget();
    await push(target);

    await prisma.manga.delete({ where: { id: manga.id } });
    const result = await push(target);

    expect(result.mangas.deleted).toBe(1);
    // The replica has no foreign keys; the orphaned events only go away
    // because the key diff catches them.
    expect(result.events.deleted).toBe(2);
    expect(target.mangas.size).toBe(0);
    expect(target.events.size).toBe(0);
  });

  it("should propagate edits to mutable manga fields", async () => {
    const manga = await seed();
    const target = createFakeTarget();
    await push(target);

    await prisma.manga.update({
      where: { id: manga.id },
      data: { status: "completed", tags: JSON.stringify(["done", "pirates"]) },
    });
    await push(target);

    expect(target.mangas.get(manga.id)?.status).toBe("completed");
    expect(target.mangas.get(manga.id)?.tags).toEqual(["done", "pirates"]);
  });
});

describe("Sync service: deletion guards", () => {
  // Regression: the first boot on a fresh machine used to mirror an empty
  // SQLite over the replica, destroying the backup it was installed to read.
  it("should refuse to push at all from an empty local database", async () => {
    const target = createFakeTarget();
    await seed();
    await push(target);
    await prisma.manga.deleteMany();
    await prisma.siteAdapter.deleteMany();

    const outcome = await pushToReplica(target, {
      covers: true,
      allowDeletions: true,
    });

    expect(outcome).toEqual({ kind: "skipped", reason: "local-empty" });
    // The replica is untouched and still restorable.
    expect(target.mangas.size).toBe(1);
    expect(target.events.size).toBe(2);
    expect(target.adapters.size).toBe(1);
  });

  it("should leave the replica intact on an additive-only push", async () => {
    const target = createFakeTarget();
    await seed();
    await push(target);

    // A second machine holding only part of the library, as after a partial
    // restore or before one.
    await prisma.manga.deleteMany();
    const kept = await prisma.manga.create({
      data: { canonicalName: "Kept", normalizedSlug: "kept" },
    });

    const outcome = await pushToReplica(target, {
      covers: false,
      allowDeletions: false,
    });

    expect(outcome.kind).toBe("pushed");
    expect(outcome.kind === "pushed" && outcome.deletionsApplied).toBe(false);
    // The new manga arrives; nothing the replica already held is removed.
    expect(target.mangas.size).toBe(2);
    expect(target.mangas.has(kept.id)).toBe(true);
    expect(target.events.size).toBe(2);
  });

  it("should report zero deletions rather than counting what it withheld", async () => {
    const target = createFakeTarget();
    const manga = await seed();
    await push(target);

    await prisma.manga.delete({ where: { id: manga.id } });
    await prisma.siteAdapter.create({
      data: { domain: "other.com", titleSelector: "h1" },
    });
    const outcome = await pushToReplica(target, {
      covers: false,
      allowDeletions: false,
    });

    expect(outcome.kind === "pushed" && outcome.mangas.deleted).toBe(0);
    expect(outcome.kind === "pushed" && outcome.events.deleted).toBe(0);
    expect(target.mangas.size).toBe(1);
  });
});

describe("Sync service: cover pass", () => {
  it("should upload cover bytes only when the pass is requested", async () => {
    const manga = await seed();
    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        coverImage: new Uint8Array([1, 2, 3]),
        coverImageType: "image/webp",
        coverVersion: 1,
      },
    });
    const target = createFakeTarget();

    await push(target);
    expect(target.covers.size).toBe(0);
    // The flag rides along with the metadata even when the bytes do not.
    expect(target.mangas.get(manga.id)?.hasStoredCover).toBe(true);

    const withCovers = await push(target, true);

    expect(withCovers.covers).toEqual({ uploaded: 1, deleted: 0 });
    expect(Array.from(target.covers.get(manga.id)?.data ?? [])).toEqual([
      1, 2, 3,
    ]);
  });

  it("should skip covers whose version did not move", async () => {
    const manga = await seed();
    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: new Uint8Array([1]), coverVersion: 1 },
    });
    const target = createFakeTarget();
    await push(target, true);

    const second = await push(target, true);
    expect(second.covers?.uploaded).toBe(0);
    expect(target.calls.coversUploaded).toBe(1);

    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: new Uint8Array([2, 2]), coverVersion: 2 },
    });
    const third = await push(target, true);

    expect(third.covers?.uploaded).toBe(1);
    expect(Array.from(target.covers.get(manga.id)?.data ?? [])).toEqual([2, 2]);
  });

  it("should prune an orphaned cover on a metadata push, without moving bytes", async () => {
    const manga = await seed();
    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: new Uint8Array([1]), coverVersion: 1 },
    });
    const target = createFakeTarget();
    await push(target, true);
    expect(target.covers.size).toBe(1);

    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: null, coverVersion: 2 },
    });
    await push(target);

    expect(target.covers.size).toBe(0);
    expect(target.mangas.get(manga.id)?.hasStoredCover).toBe(false);
  });
});

describe("Sync service: restore", () => {
  it("should refuse to overwrite a populated database", async () => {
    await seed();
    const target = createFakeTarget();
    await push(target);

    const outcome = await restoreFromReplica(target);

    expect(outcome.kind).toBe("local-not-empty");
    expect(await prisma.manga.count()).toBe(1);
  });

  it("should rebuild the library from the replica into an empty database", async () => {
    const manga = await seed();
    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        coverImage: new Uint8Array([7, 7, 7]),
        coverImageType: "image/png",
        coverVersion: 4,
      },
    });
    const target = createFakeTarget();
    await push(target, true);

    // Simulate a fresh machine: same replica, nothing local.
    await prisma.manga.deleteMany();
    await prisma.siteAdapter.deleteMany();

    const outcome = await restoreFromReplica(target);

    expect(outcome).toEqual({
      kind: "restored",
      mangas: 1,
      events: 2,
      adapters: 1,
      covers: 1,
    });

    const restored = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
      include: { events: true },
    });
    expect(restored.canonicalName).toBe("One Piece");
    expect(restored.normalizedSlug).toBe("one-piece");
    // Back to the JSON string the column holds.
    expect(restored.tags).toBe('["shonen"]');
    expect(restored.coverVersion).toBe(4);
    expect(restored.coverImageType).toBe("image/png");
    expect(Array.from(restored.coverImage ?? [])).toEqual([7, 7, 7]);
    expect(restored.events).toHaveLength(2);
    expect(await prisma.siteAdapter.count()).toBe(1);
  });

  it("should overwrite a populated database when forced", async () => {
    await seed();
    const target = createFakeTarget();
    await push(target);

    await prisma.manga.create({
      data: { canonicalName: "Local Only", normalizedSlug: "local-only" },
    });

    const outcome = await restoreFromReplica(target, { force: true });

    expect(outcome.kind).toBe("restored");
    // The local-only manga is gone: a forced restore is a replacement.
    expect(await prisma.manga.count()).toBe(1);
    expect(
      await prisma.manga.findFirst({ where: { normalizedSlug: "local-only" } }),
    ).toBe(null);
  });

  it("should survive a round trip that leaves the replica unchanged", async () => {
    await seed();
    const target = createFakeTarget();
    await push(target);

    await prisma.manga.deleteMany();
    await prisma.siteAdapter.deleteMany();
    await restoreFromReplica(target);

    // Restored rows keep their ids, so the next push has nothing to do.
    const after = await push(target);
    expect(after.events.inserted).toBe(0);
    expect(after.mangas.deleted).toBe(0);
    expect(after.events.deleted).toBe(0);
  });
});
