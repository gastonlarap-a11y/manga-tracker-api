import { describe, expect, it } from "bun:test";
import {
  asBytes,
  asDate,
  asNullableDate,
  fromAdapterDoc,
  fromCoverDoc,
  fromEventDoc,
  fromMangaDoc,
  toAdapterDoc,
  toCoverDoc,
  toEventDoc,
  toMangaDoc,
} from "./sync.mapper";

const mangaRow = {
  id: "local-uuid-1",
  canonicalName: "One Piece",
  normalizedSlug: "one-piece",
  coverUrl: "https://cdn.example/op.jpg",
  hasStoredCover: false,
  coverImageType: null,
  coverVersion: 3,
  status: "reading",
  tags: '["shonen","pirates"]',
  createdAt: new Date("2026-01-15T10:00:00.000Z"),
  updatedAt: new Date("2026-02-20T10:00:00.000Z"),
  deletedAt: null,
  mergedIntoSlug: null,
};

const eventRow = {
  id: "event-1",
  chapterLabel: "Cap. 130.5",
  chapterNumber: 130.5,
  sourceUrl: "https://olympusxyz.com/op/130-5",
  sourceDomain: "olympusxyz.com",
  readAt: new Date("2026-02-01T12:00:00.000Z"),
  seriesKey: "olympusxyz.com/one-piece",
};

const adapterRow = {
  id: "adapter-1",
  domain: "olympusxyz.com",
  titleSelector: "h1.title",
  chapterSelector: null,
  chapterUrlRegex: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

describe("Sync mapper: SQLite -> shared documents", () => {
  it("should key a manga by its slug, not by the machine-local uuid", () => {
    const doc = toMangaDoc(mangaRow);

    // Two machines that discover the same title independently produce
    // different uuids but the same slug, so this is what makes them merge
    // instead of colliding on the unique index.
    expect(doc._id).toBe("one-piece");
    expect(doc.id).toBe("local-uuid-1");
  });

  it("should carry the slug on an event so a peer can re-point it", () => {
    const doc = toEventDoc(eventRow, "one-piece");

    expect(doc._id).toBe("event-1");
    expect(doc.mangaSlug).toBe("one-piece");
    // No mangaId: the other machine's uuid would be meaningless here.
    expect(doc).not.toHaveProperty("mangaId");
  });

  it("should turn the JSON tag string into a native array", () => {
    expect(toMangaDoc(mangaRow).tags).toEqual(["shonen", "pirates"]);
  });

  it("should carry updatedAt and deletedAt, which decide every merge", () => {
    const doc = toMangaDoc(mangaRow);
    expect(doc.updatedAt).toEqual(mangaRow.updatedAt);
    expect(doc.deletedAt).toBe(null);

    const deletedAt = new Date("2026-03-01T00:00:00.000Z");
    expect(toMangaDoc({ ...mangaRow, deletedAt }).deletedAt).toEqual(deletedAt);
  });

  it("should degrade corrupt tags and status instead of throwing", () => {
    const corrupt = toMangaDoc({
      ...mangaRow,
      tags: "not-json{",
      status: "banana",
    });

    expect(corrupt.tags).toEqual([]);
    expect(corrupt.status).toBe("reading");
  });

  it("should flag stored covers without carrying their bytes", () => {
    expect(toMangaDoc(mangaRow).hasStoredCover).toBe(false);

    const withCover = toMangaDoc({ ...mangaRow, hasStoredCover: true });

    expect(withCover.hasStoredCover).toBe(true);
    expect(withCover).not.toHaveProperty("coverImage");
    expect(withCover).not.toHaveProperty("data");
  });

  it("should key a cover document by slug so it lines up with its manga", () => {
    const doc = toCoverDoc({
      normalizedSlug: "one-piece",
      coverImage: new Uint8Array([9, 8, 7]),
      coverImageType: "image/png",
      coverVersion: 3,
    });

    expect(doc._id).toBe("one-piece");
    expect(Array.from(doc.data)).toEqual([9, 8, 7]);
    expect(doc.coverVersion).toBe(3);
  });

  it("should key an adapter by its domain", () => {
    expect(toAdapterDoc(adapterRow)._id).toBe("olympusxyz.com");
    expect(toAdapterDoc(adapterRow).id).toBe("adapter-1");
  });

  it("should preserve a null chapter number rather than coercing it to zero", () => {
    expect(
      toEventDoc({ ...eventRow, chapterNumber: null }, "one-piece")
        .chapterNumber,
    ).toBe(null);
  });
});

describe("Sync mapper: shared documents -> SQLite", () => {
  it("should round-trip a manga back into its SQLite column shapes", () => {
    const restored = fromMangaDoc({ ...toMangaDoc(mangaRow) });

    expect(restored.normalizedSlug).toBe("one-piece");
    expect(restored.canonicalName).toBe("One Piece");
    // Back to the JSON string the SQLite column stores.
    expect(restored.tags).toBe('["shonen","pirates"]');
    expect(restored.createdAt).toEqual(mangaRow.createdAt);
    expect(restored.updatedAt).toEqual(mangaRow.updatedAt);
    expect(restored.deletedAt).toBe(null);
  });

  it("should round-trip events and adapters without losing their keys", () => {
    const event = fromEventDoc({ ...toEventDoc(eventRow, "one-piece") });
    expect(event.id).toBe("event-1");
    expect(event.mangaSlug).toBe("one-piece");
    expect(event.chapterNumber).toBe(130.5);
    expect(event.readAt).toEqual(eventRow.readAt);
    // Series identity travels too, so a peer keeps recognising the series.
    expect(event.seriesKey).toBe("olympusxyz.com/one-piece");

    const adapter = fromAdapterDoc({ ...toAdapterDoc(adapterRow) });
    expect(adapter.domain).toBe("olympusxyz.com");
    expect(adapter.chapterSelector).toBe(null);
  });

  it("should coerce junk fields instead of aborting a sync", () => {
    const restored = fromMangaDoc({
      _id: "some-slug",
      canonicalName: 42,
      tags: ["ok", 7, null],
      coverVersion: "three",
      status: "banana",
      createdAt: "not-a-date",
    });

    expect(restored.canonicalName).toBe("");
    expect(restored.tags).toBe('["ok"]');
    expect(restored.coverVersion).toBe(0);
    expect(restored.status).toBe("reading");
    expect(restored.createdAt).toEqual(new Date(0));
  });

  it("should never read an unparseable deletedAt as a deletion", () => {
    // Epoch means "could not read this", and treating that as deleted would
    // hide the manga on every machine that synced.
    expect(asNullableDate("garbage")).toBe(null);
    expect(asNullableDate(undefined)).toBe(null);
    expect(asNullableDate(null)).toBe(null);
    expect(fromMangaDoc({ _id: "s", deletedAt: "garbage" }).deletedAt).toBe(
      null,
    );
    expect(asNullableDate("2026-03-01T00:00:00.000Z")).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
  });

  it("should accept both a raw Uint8Array and the driver's Binary wrapper", () => {
    const raw = new Uint8Array([1, 2, 3]);
    expect(asBytes(raw)).toBe(raw);
    // Structural stand-in for mongodb's Binary.
    expect(asBytes({ buffer: raw })).toBe(raw);
    expect(asBytes("nope")).toBe(null);
  });

  it("should skip a cover document whose bytes are unreadable", () => {
    expect(fromCoverDoc({ _id: "one-piece", data: "corrupt" })).toBe(null);

    const cover = fromCoverDoc({
      _id: "one-piece",
      data: { buffer: new Uint8Array([4, 5]) },
      contentType: "image/jpeg",
      coverVersion: 2,
    });

    expect(cover?.normalizedSlug).toBe("one-piece");
    expect(Array.from(cover?.coverImage ?? [])).toEqual([4, 5]);
    // The document calls it contentType; the SQLite column is coverImageType.
    expect(cover?.coverImageType).toBe("image/jpeg");
    expect(cover?.coverVersion).toBe(2);
  });

  it("should parse dates from strings and epoch-out on garbage", () => {
    expect(asDate("2026-03-01T00:00:00.000Z")).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(asDate(new Date("invalid"))).toEqual(new Date(0));
    expect(asDate(undefined)).toEqual(new Date(0));
  });
});
