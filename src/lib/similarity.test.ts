import { describe, expect, it } from "bun:test";
import {
  levenshteinDistance,
  levenshteinSimilarity,
  titleSimilarity,
} from "./similarity";

describe("levenshteinDistance", () => {
  it("computes known distances", () => {
    expect(levenshteinDistance("kitten", "sitting")).toBe(3);
    expect(levenshteinDistance("flaw", "lawn")).toBe(2);
    expect(levenshteinDistance("solo-leveling", "solo-levelling")).toBe(1);
  });

  it("is zero for identical strings", () => {
    expect(levenshteinDistance("one-piece", "one-piece")).toBe(0);
    expect(levenshteinDistance("", "")).toBe(0);
  });

  it("degenerates to the other length against the empty string", () => {
    expect(levenshteinDistance("", "abc")).toBe(3);
    expect(levenshteinDistance("abc", "")).toBe(3);
  });
});

describe("levenshteinSimilarity", () => {
  it("is 1 for identical strings, including both empty", () => {
    expect(levenshteinSimilarity("one-piece", "one-piece")).toBe(1);
    expect(levenshteinSimilarity("", "")).toBe(1);
  });

  it("is 0 for empty vs non-empty", () => {
    expect(levenshteinSimilarity("", "one-piece")).toBe(0);
  });

  it("flags near-duplicate slugs above the 0.85 domain threshold", () => {
    const similarity = levenshteinSimilarity("solo-leveling", "solo-levelling");
    expect(similarity).toBeCloseTo(1 - 1 / 14, 4);
    expect(similarity).toBeGreaterThanOrEqual(0.85);
  });

  it("stays below threshold for unrelated slugs", () => {
    expect(levenshteinSimilarity("one-piece", "berserk")).toBeLessThan(0.85);
  });

  it("is symmetric", () => {
    expect(levenshteinSimilarity("kitten", "sitting")).toBe(
      levenshteinSimilarity("sitting", "kitten"),
    );
  });
});

// The two slugs that made the same series show up as two cards in the library.
const DRAGON_A = "callate-dragona-malvada-ya-no-quiero-criar-hijos-contigo";
const DRAGON_B = "callate-malvado-dragon-ya-no-quiero-criar-hijos-contigo";

describe("titleSimilarity", () => {
  it("recognizes the reordered, differently-inflected translation that plain edit distance misses", () => {
    // The regression this whole feature exists for: two sites, one series.
    expect(levenshteinSimilarity(DRAGON_A, DRAGON_B)).toBeLessThan(0.85);

    const match = titleSimilarity(DRAGON_A, DRAGON_B);
    expect(match.score).toBeGreaterThanOrEqual(0.92);
    expect(match.reasons).toContain("tokens");
    expect(match.sequelSuspicion).toBe(false);
  });

  it("is 1 for identical slugs", () => {
    expect(titleSimilarity("one-piece", "one-piece").score).toBe(1);
  });

  it("keeps whole-string edit distance as a floor for a typo inside one word", () => {
    // A single token on each side: tokenization has nothing to work with, and
    // "solo-levelling" must still read as the same manga.
    const match = titleSimilarity("solo-leveling", "solo-levelling");
    expect(match.score).toBeGreaterThanOrEqual(0.92);
  });

  it("keeps a sequel below the auto-merge threshold and flags it", () => {
    const match = titleSimilarity("solo-leveling", "solo-leveling-ragnarok");
    expect(match.score).toBeLessThan(0.92);
    expect(match.reasons).toContain("containment");
  });

  it("flags season and part markers so they are never merged automatically", () => {
    expect(titleSimilarity("dr-stone", "dr-stone-2").sequelSuspicion).toBe(
      true,
    );
    expect(
      titleSimilarity("tower-of-god", "tower-of-god-season-2").sequelSuspicion,
    ).toBe(true);
    expect(
      titleSimilarity("kaguya-sama", "kaguya-sama-parte-ii").sequelSuspicion,
    ).toBe(true);
  });

  it("stays low for unrelated titles", () => {
    expect(titleSimilarity("one-piece", "berserk").score).toBeLessThan(0.5);
    expect(
      titleSimilarity("attack-on-titan", "my-hero-academia").score,
    ).toBeLessThan(0.5);
  });

  it("is symmetric", () => {
    expect(titleSimilarity(DRAGON_A, DRAGON_B).score).toBe(
      titleSimilarity(DRAGON_B, DRAGON_A).score,
    );
    expect(
      titleSimilarity("solo-leveling", "solo-leveling-ragnarok").score,
    ).toBe(titleSimilarity("solo-leveling-ragnarok", "solo-leveling").score);
  });

  it("does not divide by zero on empty slugs", () => {
    expect(titleSimilarity("", "").score).toBe(1);
    expect(titleSimilarity("", "one-piece").score).toBe(0);
  });
});
