/**
 * Classic two-row dynamic-programming Levenshtein edit distance.
 * Hand-rolled on purpose: ~20 lines, exhaustively testable, and the input
 * volume (tens of slugs) makes a dependency unjustifiable.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + substitutionCost,
      );
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/**
 * Normalized similarity in [0, 1]: 1 = identical (including both empty),
 * 0 = nothing in common (e.g. empty vs non-empty).
 */
export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) {
    return 1;
  }
  const maxLength = Math.max(a.length, b.length);
  return 1 - levenshteinDistance(a, b) / maxLength;
}
