import { describe, expect, it } from "bun:test";
import {
  asBytes,
  asDate,
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
  id: "manga-1",
  canonicalName: "One Piece",
  normalizedSlug: "one-piece",
  coverUrl: "https://cdn.example/op.jpg",
  hasStoredCover: false,
  coverImageType: null,
  coverVersion: 3,
  status: "reading",
  tags: '["shonen","pirates"]',
  createdAt: new Date("2026-01-15T10:00:00.000Z"),
};

describe("Sync mapper: SQLite -> replica", () => {
  it("should key the document by the existing row id so pushes stay idempotent", () => {
    expect(toMangaDoc(mangaRow)._id).toBe("manga-1");
    expect(toEventDoc({ ...eventRow })._id).toBe("event-1");
    // The adapter's natural key is the domain, not its uuid.
    expect(toAdapterDoc(adapterRow)._id).toBe("olympusxyz.com");
    expect(toAdapterDoc(adapterRow).id).toBe("adapter-1");
  });

  it("should turn the JSON tag string into a native array", () => {
    expect(toMangaDoc(mangaRow).tags).toEqual(["shonen", "pirates"]);
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

    const withCover = toMangaDoc({
      ...mangaRow,
      hasStoredCover: true,
      coverImageType: "image/webp",
    });

    expect(withCover.hasStoredCover).toBe(true);
    // Bytes travel in their own collection, never in the manga document.
    expect(withCover).not.toHaveProperty("coverImage");
    expect(withCover).not.toHaveProperty("data");
  });

  it("should carry cover bytes and their version in the cover document", () => {
    const doc = toCoverDoc({
      id: "manga-1",
      coverImage: new Uint8Array([9, 8, 7]),
      coverImageType: "image/png",
      coverVersion: 3,
    });

    expect(doc._id).toBe("manga-1");
    expect(Array.from(doc.data)).toEqual([9, 8, 7]);
    expect(doc.contentType).toBe("image/png");
    // The version is what lets a push skip covers that did not change.
    expect(doc.coverVersion).toBe(3);
  });

  it("should preserve a null chapter number rather than coercing it to zero", () => {
    expect(toEventDoc({ ...eventRow, chapterNumber: null }).chapterNumber).toBe(
      null,
    );
  });
});

const eventRow = {
  id: "event-1",
  mangaId: "manga-1",
  chapterLabel: "Cap. 130.5",
  chapterNumber: 130.5,
  sourceUrl: "https://olympusxyz.com/op/130-5",
  sourceDomain: "olympusxyz.com",
  readAt: new Date("2026-02-01T12:00:00.000Z"),
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

describe("Sync mapper: replica -> SQLite", () => {
  it("should round-trip a manga back into its SQLite column shapes", () => {
    const restored = fromMangaDoc({ ...toMangaDoc(mangaRow) });

    expect(restored.id).toBe("manga-1");
    expect(restored.canonicalName).toBe("One Piece");
    // Back to the JSON string the SQLite column stores.
    expect(restored.tags).toBe('["shonen","pirates"]');
    expect(restored.createdAt).toEqual(mangaRow.createdAt);
  });

  it("should round-trip events and adapters without losing their keys", () => {
    const event = fromEventDoc({ ...toEventDoc(eventRow) });
    expect(event.id).toBe("event-1");
    expect(event.chapterNumber).toBe(130.5);
    expect(event.readAt).toEqual(eventRow.readAt);

    const adapter = fromAdapterDoc({ ...toAdapterDoc(adapterRow) });
    expect(adapter.domain).toBe("olympusxyz.com");
    expect(adapter.id).toBe("adapter-1");
    expect(adapter.chapterSelector).toBe(null);
  });

  it("should fall back to the domain when an adapter document predates the id field", () => {
    const adapter = fromAdapterDoc({
      _id: "legacy.com",
      titleSelector: "h1",
    });

    expect(adapter.id).toBe("legacy.com");
    expect(adapter.domain).toBe("legacy.com");
  });

  it("should coerce junk fields instead of aborting a restore", () => {
    const restored = fromMangaDoc({
      _id: "manga-2",
      canonicalName: 42,
      tags: ["ok", 7, null],
      coverVersion: "three",
      status: "banana",
      createdAt: "not-a-date",
    });

    expect(restored.canonicalName).toBe("");
    // Non-string tags are dropped, the readable ones survive.
    expect(restored.tags).toBe('["ok"]');
    expect(restored.coverVersion).toBe(0);
    expect(restored.status).toBe("reading");
    expect(restored.createdAt).toEqual(new Date(0));
  });

  it("should accept both a raw Uint8Array and the driver's Binary wrapper", () => {
    const raw = new Uint8Array([1, 2, 3]);
    expect(asBytes(raw)).toBe(raw);
    // Structural stand-in for mongodb's Binary.
    expect(asBytes({ buffer: raw })).toBe(raw);
    expect(asBytes("nope")).toBe(null);
    expect(asBytes(null)).toBe(null);
  });

  it("should skip a cover document whose bytes are unreadable", () => {
    expect(fromCoverDoc({ _id: "manga-1", data: "corrupt" })).toBe(null);

    const cover = fromCoverDoc({
      _id: "manga-1",
      data: { buffer: new Uint8Array([4, 5]) },
      contentType: "image/jpeg",
    });

    expect(cover?.mangaId).toBe("manga-1");
    expect(Array.from(cover?.coverImage ?? [])).toEqual([4, 5]);
    // The document calls it contentType; the SQLite column is coverImageType.
    expect(cover?.coverImageType).toBe("image/jpeg");
  });

  it("should parse dates from strings and epoch-out on garbage", () => {
    expect(asDate("2026-03-01T00:00:00.000Z")).toEqual(
      new Date("2026-03-01T00:00:00.000Z"),
    );
    expect(asDate(new Date("invalid"))).toEqual(new Date(0));
    expect(asDate(undefined)).toEqual(new Date(0));
  });
});
