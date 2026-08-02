// The fake target doubles as "the other machine": a test writes documents into
// it to stand for what a peer pushed, then syncs and asserts what this machine
// did with them.
import { beforeEach, describe, expect, it } from "bun:test";
import { prisma } from "../../db/client";
import { createFakeTarget, type FakeTarget } from "./sync.fake-target";
import type { MangaDoc, ReadingEventDoc } from "./sync.mapper";
import { restoreFromReplica, syncWithReplica } from "./sync.service";

const sync = (target: FakeTarget, covers = false) =>
  syncWithReplica(target, { covers });

const seedLocal = async () => {
  const manga = await prisma.manga.create({
    data: {
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      tags: JSON.stringify(["shonen"]),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  await prisma.readingEvent.createMany({
    data: [
      {
        id: "local-event-1",
        mangaId: manga.id,
        chapterLabel: "Cap. 1",
        chapterNumber: 1,
        sourceUrl: "https://olympusxyz.com/op/1",
        sourceDomain: "olympusxyz.com",
      },
    ],
  });
  return manga;
};

/** A manga document as another machine would have written it. */
const peerManga = (over: Partial<MangaDoc> = {}): MangaDoc => ({
  _id: "solo-leveling",
  id: "peer-uuid",
  canonicalName: "Solo Leveling",
  coverUrl: null,
  coverImageType: null,
  coverVersion: 0,
  hasStoredCover: false,
  status: "reading",
  tags: [],
  createdAt: new Date("2026-01-05T00:00:00.000Z"),
  updatedAt: new Date("2026-01-05T00:00:00.000Z"),
  deletedAt: null,
  ...over,
});

const peerEvent = (over: Partial<ReadingEventDoc> = {}): ReadingEventDoc => ({
  _id: "peer-event-1",
  mangaSlug: "solo-leveling",
  chapterLabel: "Cap. 179",
  chapterNumber: 179,
  sourceUrl: "https://olympusxyz.com/sl/179",
  sourceDomain: "olympusxyz.com",
  readAt: new Date("2026-02-01T00:00:00.000Z"),
  ...over,
});

beforeEach(async () => {
  await prisma.manga.deleteMany();
  await prisma.siteAdapter.deleteMany();
});

describe("Sync: the reason this exists — a stale machine must not destroy history", () => {
  it("should never remove a peer's events just because they are missing here", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);

    // The other machine recorded chapters this one has never seen.
    target.mangas.set("solo-leveling", peerManga());
    target.events.set("peer-event-1", peerEvent());
    target.events.set("peer-event-2", peerEvent({ _id: "peer-event-2" }));

    const result = await sync(target);

    // Regression: this used to delete both as "absent locally".
    expect(target.events.size).toBe(3);
    expect(result.pulled.events).toBe(2);
    expect(await prisma.readingEvent.count()).toBe(3);
  });

  it("should bring a stale machine up to date before it pushes anything", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);
    target.mangas.set("solo-leveling", peerManga());
    target.events.set("peer-event-1", peerEvent());

    await sync(target);

    // The peer's manga now exists here, with this machine's own uuid, and its
    // event hangs off it.
    const pulledManga = await prisma.manga.findUniqueOrThrow({
      where: { normalizedSlug: "solo-leveling" },
      include: { events: true },
    });
    expect(pulledManga.canonicalName).toBe("Solo Leveling");
    expect(pulledManga.events).toHaveLength(1);
    expect(pulledManga.events[0]?.chapterLabel).toBe("Cap. 179");
  });

  it("should merge two machines that discovered the same title separately", async () => {
    const target = createFakeTarget();
    // The peer already knows this title under its own uuid.
    target.mangas.set(
      "solo-leveling",
      peerManga({ updatedAt: new Date("2026-01-05T00:00:00.000Z") }),
    );
    // This machine created it independently: different uuid, same slug.
    await prisma.manga.create({
      data: {
        canonicalName: "Solo Leveling",
        normalizedSlug: "solo-leveling",
        createdAt: new Date("2026-01-06T00:00:00.000Z"),
        updatedAt: new Date("2026-01-06T00:00:00.000Z"),
      },
    });

    await sync(target);

    // One manga, not a unique-index crash: the slug is the shared identity.
    expect(await prisma.manga.count()).toBe(1);
    expect(target.mangas.size).toBe(1);
  });
});

describe("Sync: events converge as a union", () => {
  it("should move new events in both directions at once", async () => {
    const target = createFakeTarget();
    await seedLocal();
    target.mangas.set("solo-leveling", peerManga());
    target.events.set("peer-event-1", peerEvent());

    const result = await sync(target);

    expect(result.pulled.events).toBe(1);
    expect(result.pushed.events).toBe(1);
    expect(await prisma.readingEvent.count()).toBe(2);
    expect(target.events.size).toBe(2);
  });

  it("should move nothing on a second sync", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);

    // The fake throws on a duplicate event insert, so a re-send fails loudly.
    const second = await sync(target);

    expect(second.pulled).toEqual({
      mangas: 0,
      events: 0,
      adapters: 0,
      covers: 0,
    });
    expect(second.pushed.events).toBe(0);
    expect(second.pushed.mangas).toBe(0);
  });
});

describe("Sync: last-write-wins on mutable fields", () => {
  it("should let a newer peer edit overwrite this machine", async () => {
    const target = createFakeTarget();
    const manga = await seedLocal();
    await sync(target);

    target.mangas.set(
      "one-piece",
      peerManga({
        _id: "one-piece",
        canonicalName: "One Piece",
        status: "completed",
        tags: ["done"],
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    const result = await sync(target);

    const merged = await prisma.manga.findUniqueOrThrow({
      where: { id: manga.id },
    });
    expect(merged.status).toBe("completed");
    expect(merged.tags).toBe('["done"]');
    expect(result.pulled.mangas).toBe(1);
  });

  it("should keep this machine's edit when the peer's is older", async () => {
    const target = createFakeTarget();
    const manga = await seedLocal();
    await sync(target);

    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        status: "dropped",
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    target.mangas.set(
      "one-piece",
      peerManga({
        _id: "one-piece",
        status: "completed",
        updatedAt: new Date("2026-03-01T00:00:00.000Z"),
      }),
    );

    await sync(target);

    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: manga.id } }))
        .status,
    ).toBe("dropped");
    // And the shared store now carries the winner.
    expect(target.mangas.get("one-piece")?.status).toBe("dropped");
  });
});

describe("Sync: deletion travels as a value", () => {
  it("should apply a peer's deletion and hide the manga here", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);

    target.mangas.set(
      "one-piece",
      peerManga({
        _id: "one-piece",
        canonicalName: "One Piece",
        deletedAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    await sync(target);

    const merged = await prisma.manga.findUniqueOrThrow({
      where: { normalizedSlug: "one-piece" },
    });
    expect(merged.deletedAt).not.toBe(null);
    // The events stay: the log is append-only and the manga may come back.
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("should not let a deletion be undone by the next sync", async () => {
    const target = createFakeTarget();
    const manga = await seedLocal();
    await sync(target);

    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        deletedAt: new Date("2026-06-01T00:00:00.000Z"),
        updatedAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    await sync(target);
    await sync(target);

    expect(target.mangas.get("one-piece")?.deletedAt).not.toBe(null);
    expect(
      (await prisma.manga.findUniqueOrThrow({ where: { id: manga.id } }))
        .deletedAt,
    ).not.toBe(null);
  });
});

describe("Sync: cover bytes", () => {
  it("should leave bytes alone unless the cover pass is requested", async () => {
    const target = createFakeTarget();
    const manga = await seedLocal();
    await prisma.manga.update({
      where: { id: manga.id },
      data: {
        coverImage: new Uint8Array([1, 2, 3]),
        coverImageType: "image/webp",
        coverVersion: 1,
      },
    });

    await sync(target);
    expect(target.covers.size).toBe(0);
    // The flag rides along with the metadata even when the bytes do not.
    expect(target.mangas.get("one-piece")?.hasStoredCover).toBe(true);

    const withCovers = await sync(target, true);
    expect(withCovers.pushed.covers).toBe(1);
    expect(Array.from(target.covers.get("one-piece")?.data ?? [])).toEqual([
      1, 2, 3,
    ]);
  });

  it("should pull a peer's cover that this machine lacks", async () => {
    const target = createFakeTarget();
    await seedLocal();
    target.mangas.set(
      "solo-leveling",
      peerManga({ hasStoredCover: true, coverVersion: 2 }),
    );
    target.covers.set("solo-leveling", {
      _id: "solo-leveling",
      data: new Uint8Array([4, 5, 6]),
      contentType: "image/png",
      coverVersion: 2,
    });

    const result = await sync(target, true);

    expect(result.pulled.covers).toBe(1);
    const pulled = await prisma.manga.findUniqueOrThrow({
      where: { normalizedSlug: "solo-leveling" },
    });
    expect(Array.from(pulled.coverImage ?? [])).toEqual([4, 5, 6]);
    expect(pulled.coverImageType).toBe("image/png");
  });

  it("should skip covers whose version did not move", async () => {
    const target = createFakeTarget();
    const manga = await seedLocal();
    await prisma.manga.update({
      where: { id: manga.id },
      data: { coverImage: new Uint8Array([1]), coverVersion: 1 },
    });
    await sync(target, true);

    const second = await sync(target, true);

    expect(second.pushed.covers).toBe(0);
    expect(second.pulled.covers).toBe(0);
    expect(target.calls.coversUploaded).toBe(1);
  });
});

describe("Sync: restore", () => {
  it("should refuse to replace a populated database", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);

    const outcome = await restoreFromReplica(target);

    expect(outcome.kind).toBe("local-not-empty");
    expect(await prisma.manga.count()).toBe(1);
  });

  it("should rebuild the library from the shared store when forced", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target, true);

    await prisma.manga.create({
      data: { canonicalName: "Local Only", normalizedSlug: "local-only" },
    });
    const outcome = await restoreFromReplica(target, { force: true });

    expect(outcome.kind).toBe("restored");
    // A forced restore is a replacement: the local-only manga is gone.
    expect(await prisma.manga.count()).toBe(1);
    expect(
      await prisma.manga.findFirst({ where: { normalizedSlug: "local-only" } }),
    ).toBe(null);
    expect(await prisma.readingEvent.count()).toBe(1);
  });

  it("should reconstruct an empty machine and then have nothing left to do", async () => {
    const target = createFakeTarget();
    await seedLocal();
    await sync(target);

    await prisma.manga.deleteMany();
    await restoreFromReplica(target);

    // Ids are preserved through the store, so the next sync is a no-op.
    const after = await sync(target);
    expect(after.pulled.events).toBe(0);
    expect(after.pushed.events).toBe(0);
    expect(await prisma.readingEvent.count()).toBe(1);
  });
});
