import { describe, expect, it } from "bun:test";
import {
  chapterKey,
  isSiteNameTitle,
  normalizeSlug,
  parseChapterNumber,
  seriesKeyFromUrl,
} from "./normalize";

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

describe("seriesKeyFromUrl", () => {
  it("keys a series by host and path, ignoring query, hash and case", () => {
    expect(seriesKeyFromUrl("https://Sitio-A.com/manga/Dragona/")).toBe(
      "sitio-a.com/manga/dragona",
    );
    expect(
      seriesKeyFromUrl("https://sitio-a.com/manga/dragona?ref=home#top"),
    ).toBe("sitio-a.com/manga/dragona");
  });

  it("gives the same key for the same series page written differently", () => {
    // The point of the key: one series page, one identity, whatever the site
    // decides to call the series in its <title> today.
    expect(seriesKeyFromUrl("https://sitio-a.com/manga/dragona")).toBe(
      seriesKeyFromUrl("https://sitio-a.com/manga/dragona/"),
    );
  });

  it("returns null for anything that identifies no series", () => {
    expect(seriesKeyFromUrl("https://sitio-a.com/")).toBeNull();
    expect(seriesKeyFromUrl("https://sitio-a.com")).toBeNull();
    expect(seriesKeyFromUrl("not-a-url")).toBeNull();
    expect(seriesKeyFromUrl("javascript:alert(1)")).toBeNull();
  });

  it("keeps two sites apart even when the path matches", () => {
    expect(seriesKeyFromUrl("https://sitio-a.com/manga/dragona")).not.toBe(
      seriesKeyFromUrl("https://sitio-b.com/manga/dragona"),
    );
  });
});

describe("chapterKey", () => {
  it("treats the same number under different labels as one chapter", () => {
    expect(chapterKey({ chapterNumber: 49, chapterLabel: "Cap. 49" })).toBe(
      chapterKey({ chapterNumber: 49, chapterLabel: "Chapter 49" }),
    );
  });

  it("falls back to the exact label when nothing parsed", () => {
    expect(
      chapterKey({ chapterNumber: null, chapterLabel: "Especial" }),
    ).not.toBe(chapterKey({ chapterNumber: null, chapterLabel: "Omake" }));
  });

  it("never confuses a number with a label that reads the same", () => {
    expect(chapterKey({ chapterNumber: 5, chapterLabel: "5" })).not.toBe(
      chapterKey({ chapterNumber: null, chapterLabel: "5" }),
    );
  });
});

describe("isSiteNameTitle", () => {
  const CHAPTER_URL =
    "https://lectorxd.com/manhwa/subida-de-nivel-infinita-en-murim/leer/1";

  it("catches the interstitial that filed two series under one card", () => {
    // The measured signature: Cloudflare answers the chapter's own URL with the
    // hostname as its only heading.
    expect(isSiteNameTitle("lectorxd.com", CHAPTER_URL)).toBe(true);
  });

  it("ignores case and a www. the title does not carry", () => {
    expect(isSiteNameTitle("LectorXD.com", CHAPTER_URL)).toBe(true);
    expect(
      isSiteNameTitle("lectorxd.com", "https://www.lectorxd.com/x/leer/1"),
    ).toBe(true);
  });

  it("lets a real manga through, including one named after its site", () => {
    expect(
      isSiteNameTitle("Subida de nivel infinita en Murim", CHAPTER_URL),
    ).toBe(false);
    // Only the full hostname is branding. A bare word is a name a series may
    // legitimately share with the site hosting it.
    expect(isSiteNameTitle("LectorXD", CHAPTER_URL)).toBe(false);
    // The mhscans title that motivated the extension's own branding filter is
    // not an exact hostname, so this narrower rule leaves it alone.
    expect(
      isSiteNameTitle(
        "MHScans - MHScans (Oficial)",
        "https://mhscans.com/series/espadachin/capitulo-89/",
      ),
    ).toBe(false);
  });

  it("says nothing about a source URL it cannot parse", () => {
    expect(isSiteNameTitle("lectorxd.com", "not-a-url")).toBe(false);
  });

  it("does not collapse punctuation onto a hostname of punctuation", () => {
    // Both sides fall back to "unknown-title" without the guard.
    expect(isSiteNameTitle("!!!", "https://%2E%2E.com/leer/1")).toBe(false);
  });
});
