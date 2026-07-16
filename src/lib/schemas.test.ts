import { describe, expect, it } from "bun:test";
import { toEventDto, toMangaDto } from "./schemas";

describe("toMangaDto", () => {
  it("converts createdAt to an ISO string", () => {
    const createdAt = new Date("2026-07-01T10:00:00.000Z");
    const dto = toMangaDto({
      id: "m1",
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      createdAt,
    });

    expect(dto).toEqual({
      id: "m1",
      canonicalName: "One Piece",
      normalizedSlug: "one-piece",
      createdAt: "2026-07-01T10:00:00.000Z",
    });
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
