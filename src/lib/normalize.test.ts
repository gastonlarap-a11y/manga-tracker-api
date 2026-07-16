import { describe, expect, it } from "bun:test";
import { normalizeSlug, parseChapterNumber } from "./normalize";

describe("Domain Utilities: normalizeSlug", () => {
  it("should normalize diacritics and accents correctly", () => {
    // Asserting accent removal and lowercase conversion
    expect(normalizeSlug("Shingeki nó Kyojín")).toBe("shingeki-no-kyojin");
    expect(normalizeSlug("Boku no Hero Academiá!")).toBe(
      "boku-no-hero-academia",
    );
  });

  it("should resolve identical slugs regardless of trailing stop words", () => {
    // Core deduplication business rule
    const expectedSlug = "one-piece";

    expect(normalizeSlug("One Piece")).toBe(expectedSlug);
    expect(normalizeSlug("One Piece Manga")).toBe(expectedSlug);
    expect(normalizeSlug("One Piece comic")).toBe(expectedSlug);

    // Testing multiple stacked suffixes
    expect(normalizeSlug("One Piece-manhwa-novel")).toBe(expectedSlug);
  });

  it("should handle unexpected or empty inputs gracefully", () => {
    expect(normalizeSlug("")).toBe("");
    expect(normalizeSlug("   ")).toBe("");

    // A work literally named "Manga" is valid and should not be stripped
    expect(normalizeSlug("Manga")).toBe("manga");

    // Fallback when the entire string is just invalid characters stripped by regex
    expect(normalizeSlug("!@# $%^")).toBe("unknown-title");
  });
});

describe("Domain Utilities: parseChapterNumber", () => {
  it("should parse standard integer chapter numbers", () => {
    expect(parseChapterNumber("Chapter 12")).toBe(12);
    expect(parseChapterNumber("Capítulo 7")).toBe(7);
    expect(parseChapterNumber("Ch. 01")).toBe(1);
  });

  it("should parse chapters with decimals correctly", () => {
    // Testing the decimal capture group
    expect(parseChapterNumber("Cap. 130.5")).toBe(130.5);
    expect(parseChapterNumber("Ch 99.9")).toBe(99.9);
    expect(parseChapterNumber("10.2")).toBe(10.2);
  });

  it("should return null when no numeric value is found", () => {
    // Guarding against non-numeric payloads
    expect(parseChapterNumber("Capítulo Especial")).toBeNull();
    expect(parseChapterNumber("Extra Chapter Omake")).toBeNull();
    expect(parseChapterNumber("")).toBeNull();
  });
});
