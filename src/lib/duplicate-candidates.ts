/**
 * Which pairs of titles are worth scoring at all.
 *
 * /duplicates scored every title against every other: fine for tens of
 * mangas, and a quadratic wall after that — 114 ms at 142, around 11 s at
 * 1 400, hours at 10 000. A pair can only reach a suggestion through two
 * signals (titleSimilarity's token score or its whole-string edit score, and
 * a shared cover), so each title is reduced to keys such that two titles that
 * could reach one always share a key. Only pairs sharing one are scored.
 *
 * - **Tokens.** The token score is zero unless some pair of words has an edit
 *   similarity of at least 0.8: at most d ≤ 0.2·max(La, Lb) edits. Two words
 *   that close share a string each reaches by deleting letters (the SymSpell
 *   property) — and neither has to delete more than a fifth of its own
 *   letters to reach it. With `a` the longer word, the edits are s
 *   substitutions, i insertions and r removals, s + i + r ≤ 0.2·La: `a`
 *   deletes s + r ≤ 0.2·La, and since La = Lb + r − i, `b` deletes
 *   s + i ≤ s + 1.2i + 0.8r ≤ 0.2·Lb. So every word yields itself and its
 *   deletions up to ⌊L/5⌋ — capped at 3, past which a word is long enough to
 *   share another key anyway. (It was ⌊L/4⌋, from bounding by the partner's
 *   length; the extra level was a short, common key on every word, and most
 *   of the pairs scored at ten thousand titles.)
 * - **The whole title.** A slug that differs in its dashes ("solo-leveling",
 *   "sololeveling") shares no word but scores high on edit distance; the
 *   joined letters and their single deletions catch it.
 * - **The words as a set**, whole and minus each one: reorderings, one word
 *   spelt differently, one word added — whatever the words themselves are.
 * - **The cover.** The same cover URL is a pair whatever the titles say.
 *
 * A key shared by too many titles is dropped: it is a common word, and the
 * pairs it would add are the quadratic cost this exists to avoid. Titles that
 * really are the same share rarer keys too — checked against brute force in
 * the tests.
 */

/** Words shorter than this pair only when identical, and are too common to key on. */
const MIN_TOKEN = 3;
/** Past this depth a neighbourhood grows combinatorially and buys nothing. */
const MAX_DEPTH = 3;

function deletionNeighbourhood(word: string, depth: number): Set<string> {
  const all = new Set([word]);
  let frontier = [word];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (let index = 0; index < current.length; index++) {
        const variant = current.slice(0, index) + current.slice(index + 1);
        if (!all.has(variant)) {
          all.add(variant);
          next.push(variant);
        }
      }
    }
    frontier = next;
  }
  return all;
}

/** The keys one title is filed under. Pure; exported for the tests. */
export function blockingKeys(slug: string): string[] {
  const keys = new Set<string>();
  const tokens = slug.split("-").filter((token) => token.length > 0);
  for (const token of tokens) {
    if (token.length < MIN_TOKEN) {
      continue;
    }
    const depth = Math.min(Math.floor(token.length / 5), MAX_DEPTH);
    for (const variant of deletionNeighbourhood(token, depth)) {
      keys.add(`t:${variant}`);
    }
  }
  for (const variant of deletionNeighbourhood(tokens.join(""), 1)) {
    keys.add(`j:${variant}`);
  }
  // The words as a set, whole and with each one left out: the same words in
  // another order, one word misspelt or translated differently, one word
  // added. Rare by construction, so they survive the frequency cap — which is
  // what keeps a title made only of common words from losing its variants.
  if (tokens.length >= 2) {
    const sorted = tokens.toSorted();
    keys.add(`s:${sorted.join("-")}`);
    for (let index = 0; index < sorted.length; index++) {
      keys.add(`s:${sorted.toSpliced(index, 1).join("-")}`);
    }
    // Every word inflected differently at once — "dragona-malvada" and
    // "dragon-malvado", two translations of one title — share their stems.
    keys.add(`i:${tokens.map(stem).toSorted().join("-")}`);
  }
  return [...keys];
}

/**
 * A word without the gender and number endings Spanish and Portuguese titles
 * differ by. Only for keying: two different words can share a stem, which at
 * worst makes one more pair get scored.
 */
function stem(token: string): string {
  return token.length > 3 ? token.replace(/(?:os|as|es|s|o|a|e)$/, "") : token;
}

export interface Candidate {
  readonly slug: string;
  readonly coverUrl: string | null;
}

/**
 * The index pairs [i, j], i < j, of candidates that share at least one key,
 * in ascending (i, j) order — the order a full double loop would visit them,
 * so the caller's results come out in the same order they always did.
 */
export function candidatePairs(
  candidates: readonly Candidate[],
): [number, number][] {
  const postings = new Map<string, number[]>();
  const file = (key: string, index: number) => {
    const list = postings.get(key);
    if (list === undefined) {
      postings.set(key, [index]);
    } else {
      list.push(index);
    }
  };
  candidates.forEach((candidate, index) => {
    for (const key of blockingKeys(candidate.slug)) {
      file(key, index);
    }
    if (candidate.coverUrl !== null) {
      file(`c:${candidate.coverUrl}`, index);
    }
  });

  // Generous for a small library (every key counts), proportional for a big
  // one: a key in 2% of 10 000 titles is a common word, not evidence.
  const cap = Math.max(64, Math.ceil(candidates.length * 0.02));
  const seen = new Set<number>();
  const pairs: [number, number][] = [];
  const width = candidates.length;
  for (const [key, list] of postings) {
    // A cover is proof, however many titles share it.
    if (list.length < 2 || (list.length > cap && !key.startsWith("c:"))) {
      continue;
    }
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const code = list[a] * width + list[b];
        if (!seen.has(code)) {
          seen.add(code);
          pairs.push([list[a], list[b]]);
        }
      }
    }
  }
  return pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}
