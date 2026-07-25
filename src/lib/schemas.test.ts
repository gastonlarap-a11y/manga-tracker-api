import { describe, expect, it } from "bun:test";
import { statusFromDb, tagsFromJson, toEventDto, toMangaDto } from "./schemas";

describe("toMangaDto", () => {
  it("converts createdAt to ISO and decodes status and tags", () => {
    const createdAt = new Date("2026-07-01T10:00:00.000Z");
    const dto = toMangaDto({
      id: "m1",
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      coverUrl: "https://example.com/cover.jpg",
      coverImage: new Uint8Array([1, 2]),
      coverVersion: 2,
      status: "completed",
      tags: '["shonen","piratas"]',
      createdAt,
    });

    expect(dto).toEqual({
      id: "m1",
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      coverUrl: "https://example.com/cover.jpg",
      coverVersion: 2,
      hasStoredCover: true,
      status: "completed",
      tags: ["shonen", "piratas"],
      createdAt: "2026-07-01T10:00:00.000Z",
    });
  });
});

describe("tagsFromJson", () => {
  it.each([
    ['["a","b"]', ["a", "b"]],
    ["[]", []],
    ["not json", []],
    ['{"a":1}', []],
    ['["a",1]', ["a"]],
  ])("decodes %s", (raw, expected) => {
    expect(tagsFromJson(raw)).toEqual(expected);
  });
});

describe("statusFromDb", () => {
  it("keeps valid statuses and degrades unknown values to reading", () => {
    expect(statusFromDb("completed")).toBe("completed");
    expect(statusFromDb("dropped")).toBe("dropped");
    expect(statusFromDb("garbage")).toBe("reading");
  });
});

describe("toEventDto", () => {
  it("converts readAt to an ISO string and keeps a null chapterNumber", () => {
    const readAt = new Date("2026-07-02T20:30:00.000Z");
    const dto = toEventDto({
      id: "e1",
      mangaId: "m1",
      chapterLabel: "Extra Omake",
      chapterNumber: null,
      sourceUrl: "https://olympusxyz.com/one-piece/extra",
      sourceDomain: "olympusxyz.com",
      readAt,
    });

    expect(dto.readAt).toBe("2026-07-02T20:30:00.000Z");
    expect(dto.chapterNumber).toBeNull();
  });
});
