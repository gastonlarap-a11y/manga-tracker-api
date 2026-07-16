import { describe, expect, it } from "bun:test";
import { levenshteinDistance, levenshteinSimilarity } from "./similarity";

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
