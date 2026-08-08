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

/** Why a pair scored the way it did — the dashboard shows this verbatim. */
export type TitleMatchReason = "tokens" | "edit-distance" | "containment";

export interface TitleMatch {
  /** [0, 1]; 1 = the same title. */
  score: number;
  reasons: TitleMatchReason[];
  /**
   * The leftover tokens name a season, a part or a spin-off. Such a pair is
   * never merged automatically, however high it scores: "Solo Leveling" and
   * "Solo Leveling: Ragnarok" ARE different series.
   */
  sequelSuspicion: boolean;
}

// Two tokens count as the same word above this: "dragona"/"dragon" is 0.857 and
// "malvada"/"malvado" is 0.857 — the inflection differences that show up when
// two sites translate one Japanese title independently. Below ~0.75 unrelated
// short words start pairing up ("hijos"/"hijas" is 0.8 and genuinely ambiguous).
const TOKEN_MATCH_THRESHOLD = 0.8;

// Words that, left unpaired, mean the two titles are RELATED, not identical.
// Bare digits are in here because "dr-stone-2" is how sites spell a second
// season; a digit that pairs with a digit on the other side never reaches this.
const SEQUEL_MARKERS = new Set([
  "season",
  "temporada",
  "parte",
  "part",
  "ii",
  "iii",
  "iv",
  "gaiden",
  "spinoff",
  "spin",
  "sequel",
  "prequel",
  "remake",
  "reboot",
  "colored",
  "color",
  "after",
  "final",
  "origin",
  "origins",
  "side",
  "story",
  "0",
  "2",
  "3",
  "4",
  "5",
  "6",
]);

/**
 * Domain policy, kept next to the scoring it thresholds so both numbers are
 * read together. They live in lib rather than in the duplicates module because
 * the ingestion path needs them too, and modules never import each other.
 */
/** At or above this, and with no sequel marker, the ingestion merges on its own. */
export const AUTO_MERGE_SCORE = 0.92;
/** At or above this, the pair is worth surfacing in /duplicates for a human. */
export const SUGGEST_SCORE = 0.75;

/** Safe to merge without asking: high score AND not a season/spin-off. */
export function isConfidentMatch(match: TitleMatch): boolean {
  return match.score >= AUTO_MERGE_SCORE && !match.sequelSuspicion;
}

interface TokenPair {
  indexA: number;
  indexB: number;
  similarity: number;
  /** Lexicographically ordered, so the tie-break does not depend on argument order. */
  tieBreak: string;
}

/**
 * How likely two normalized slugs name the same manga.
 *
 * Plain edit distance is not enough here, and the failure is not hypothetical:
 *   callate-dragona-malvada-ya-no-quiero-criar-hijos-contigo   (site A)
 *   callate-malvado-dragon-ya-no-quiero-criar-hijos-contigo    (site B)
 * score 0.79 as whole strings — two reordered, differently-inflected words are
 * a long run of edits in the middle of a 56-character slug — yet they are the
 * same series. Comparing token by token, with fuzzy pairing, gives 0.96.
 *
 * The token score is weighted by word length so that "quiero" counts for more
 * than "ya", and the whole-string edit distance is still taken as a floor: it
 * wins for a typo inside one long single word, where tokenization has nothing
 * to work with.
 *
 * Symmetric by construction: candidate pairs are ranked with a tie-break that
 * does not depend on which slug was passed first.
 */
export function titleSimilarity(slugA: string, slugB: string): TitleMatch {
  const editScore = levenshteinSimilarity(slugA, slugB);
  if (slugA === slugB) {
    return { score: 1, reasons: ["tokens"], sequelSuspicion: false };
  }

  const tokensA = tokenize(slugA);
  const tokensB = tokenize(slugB);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return {
      score: editScore,
      reasons: ["edit-distance"],
      sequelSuspicion: false,
    };
  }

  const candidates: TokenPair[] = [];
  for (let i = 0; i < tokensA.length; i++) {
    for (let j = 0; j < tokensB.length; j++) {
      const similarity = levenshteinSimilarity(tokensA[i], tokensB[j]);
      if (similarity >= TOKEN_MATCH_THRESHOLD) {
        const [first, second] = [tokensA[i], tokensB[j]].toSorted();
        candidates.push({
          indexA: i,
          indexB: j,
          similarity,
          tieBreak: `${first}|${second}`,
        });
      }
    }
  }
  // Best pairs claim their tokens first; a token is spent once. Greedy rather
  // than optimal assignment: with a dozen tokens the difference never showed up
  // in the fixtures, and Hungarian matching here would be pure ceremony.
  candidates.sort(
    (x, y) =>
      y.similarity - x.similarity || x.tieBreak.localeCompare(y.tieBreak),
  );

  const takenA = new Set<number>();
  const takenB = new Set<number>();
  let matchedWeight = 0;
  for (const pair of candidates) {
    if (takenA.has(pair.indexA) || takenB.has(pair.indexB)) {
      continue;
    }
    takenA.add(pair.indexA);
    takenB.add(pair.indexB);
    const averageLength =
      (tokensA[pair.indexA].length + tokensB[pair.indexB].length) / 2;
    matchedWeight += pair.similarity * averageLength;
  }

  const totalWeight = weightOf(tokensA) + weightOf(tokensB);
  const tokenScore = (2 * matchedWeight) / totalWeight;

  const unmatched = [
    ...tokensA.filter((_, i) => !takenA.has(i)),
    ...tokensB.filter((_, j) => !takenB.has(j)),
  ];

  const reasons: TitleMatchReason[] = [];
  if (tokenScore >= editScore) {
    reasons.push("tokens");
  } else {
    reasons.push("edit-distance");
  }
  // Every word of the shorter title is present in the longer one: the site
  // truncated the title, or added a subtitle to it.
  if (
    unmatched.length > 0 &&
    (takenA.size === tokensA.length || takenB.size === tokensB.length)
  ) {
    reasons.push("containment");
  }

  return {
    score: Math.max(tokenScore, editScore),
    reasons,
    sequelSuspicion: unmatched.some((token) => SEQUEL_MARKERS.has(token)),
  };
}

function tokenize(slug: string): string[] {
  return slug.split("-").filter((token) => token.length > 0);
}

function weightOf(tokens: string[]): number {
  return tokens.reduce((total, token) => total + token.length, 0);
}
