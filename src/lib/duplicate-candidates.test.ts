import { describe, expect, it } from "bun:test";
import {
  blockingKeys,
  type Candidate,
  candidatePairs,
} from "./duplicate-candidates";
import { SUGGEST_SCORE, titleSimilarity } from "./similarity";

/** A seeded generator, so the corpus is the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "el",
  "la",
  "de",
  "del",
  "no",
  "ya",
  "quiero",
  "dragon",
  "dragona",
  "malvado",
  "malvada",
  "criar",
  "hijos",
  "contigo",
  "torre",
  "solitario",
  "cultivando",
  "noble",
  "familia",
  "rebelde",
  "secta",
  "montana",
  "genio",
  "marcial",
  "recuerda",
  "todo",
  "invocacion",
  "reencarnacion",
  "villana",
  "eliminar",
  "regresion",
  "absoluta",
  "emperador",
  "demonio",
  "senor",
  "solo",
  "leveling",
  "tower",
  "god",
  "return",
  "hero",
  "academy",
  "magic",
  "sword",
  "saint",
  "kingdom",
  "tensei",
  "shitara",
  "slime",
  "datta",
  "ken",
  "isekai",
  "maou",
  "yuusha",
  "kimi",
  "sekai",
  "owari",
  "the",
  "of",
  "a",
  "legendary",
  "mercenary",
  "omniscient",
  "reader",
  "viewpoint",
  "martial",
  "peak",
  "apotheosis",
  "chronicles",
  "heavenly",
  "demon",
  "cultivator",
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

function typo(random: () => number, word: string): string {
  if (word.length < 4) {
    return word;
  }
  const index = 1 + Math.floor(random() * (word.length - 2));
  const letter = "abcdefghijklmnopqrstuvwxyz"[Math.floor(random() * 26)];
  return word.slice(0, index) + letter + word.slice(index + 1);
}

/**
 * Titles plus the variants two sites really produce of one: a typo, words
 * reordered, a subtitle added, an inflection, the dashes dropped, a season.
 */
function corpus(size: number, seed: number): Candidate[] {
  const random = mulberry32(seed);
  const titles: string[] = [];
  while (titles.length < size) {
    const length = 2 + Math.floor(random() * 6);
    const words = Array.from({ length }, () => pick(random, WORDS));
    titles.push(words.join("-"));
    const variant = Math.floor(random() * 8);
    if (variant === 0) {
      titles.push(words.map((word) => typo(random, word)).join("-"));
    } else if (variant === 1) {
      titles.push(words.toReversed().join("-"));
    } else if (variant === 2) {
      titles.push(
        [...words, pick(random, WORDS), pick(random, WORDS)].join("-"),
      );
    } else if (variant === 3) {
      titles.push(words.map((word) => word.replace(/o$/, "a")).join("-"));
    } else if (variant === 4) {
      titles.push(words.join(""));
    } else if (variant === 5) {
      titles.push([...words, "2"].join("-"));
    }
  }
  return titles.slice(0, size).map((slug, index) => ({
    slug,
    // A few share a cover, which is a pair however the titles read.
    coverUrl: index % 37 === 0 ? "https://cdn.example/shared.webp" : null,
  }));
}

function isPair(a: Candidate, b: Candidate): boolean {
  if (a.coverUrl !== null && a.coverUrl === b.coverUrl) {
    return true;
  }
  return titleSimilarity(a.slug, b.slug).score >= SUGGEST_SCORE;
}

function bruteForce(candidates: readonly Candidate[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (isPair(candidates[i] as Candidate, candidates[j] as Candidate)) {
        found.push(`${i}:${j}`);
      }
    }
  }
  return found;
}

function blocked(candidates: readonly Candidate[]): string[] {
  return candidatePairs(candidates)
    .filter(([i, j]) =>
      isPair(candidates[i] as Candidate, candidates[j] as Candidate),
    )
    .map(([i, j]) => `${i}:${j}`);
}

describe("candidatePairs", () => {
  it.each([1, 2, 3])(
    "finds every pair a full comparison finds (corpus %i)",
    (seed) => {
      const candidates = corpus(400, seed);

      expect(blocked(candidates)).toEqual(bruteForce(candidates));
    },
  );

  it("scores far fewer pairs than all of them", () => {
    const candidates = corpus(400, 7);
    const all = (candidates.length * (candidates.length - 1)) / 2;

    expect(candidatePairs(candidates).length).toBeLessThan(all / 4);
  });

  it("pairs titles that differ only in their dashes", () => {
    const pairs = candidatePairs([
      { slug: "solo-leveling", coverUrl: null },
      { slug: "sololeveling", coverUrl: null },
    ]);

    expect(pairs).toEqual([[0, 1]]);
  });

  it("pairs a shared cover whatever the titles say", () => {
    const cover = "https://cdn.example/x.webp";

    expect(
      candidatePairs([
        { slug: "nada-que-ver", coverUrl: cover },
        { slug: "otra-cosa-distinta", coverUrl: cover },
      ]),
    ).toEqual([[0, 1]]);
  });
});

/**
 * A library at scale: thousands of titles over a vocabulary of made-up words
 * drawn with very unequal frequency — a few words in most titles, as "the",
 * "de" or "isekai" are, and a long tail of rare ones. That is what makes the
 * frequency cap drop keys; a small corpus never reaches it.
 *
 * Some titles are followed by a variant of themselves — what a second site
 * makes of the same series — and those planted pairs are what the cap must
 * never lose. Pairs of unrelated titles that only share one very common long
 * word also score above the threshold, and are exactly the noise the cap
 * exists to keep out of the report.
 */
function corpusAtScale(
  size: number,
  seed: number,
): { candidates: Candidate[]; planted: [number, number][] } {
  const random = mulberry32(seed);
  // Few syllables, so words collide and the most common ones are in a large
  // share of the titles: harsher than a real library, on purpose.
  const syllables = ["ka", "ri", "to", "ma", "shi", "ne", "ra", "yu", "ko"];
  const vocabulary = Array.from({ length: 3000 }, () =>
    Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
      pick(random, syllables),
    ).join(""),
  );
  // Zipf-like: the word at rank r is picked with weight 1 / (r + 1).
  const weights = vocabulary.map((_, rank) => 1 / (rank + 1));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const word = () => {
    let roll = random() * total;
    for (let rank = 0; rank < weights.length; rank++) {
      roll -= weights[rank] as number;
      if (roll <= 0) {
        return vocabulary[rank] as string;
      }
    }
    return vocabulary.at(-1) as string;
  };
  const slugs: string[] = [];
  const planted: [number, number][] = [];
  while (slugs.length < size) {
    const words = Array.from({ length: 2 + Math.floor(random() * 6) }, word);
    slugs.push(words.join("-"));
    // What a second site makes of one title: a word misspelt, the words
    // reordered, a subtitle word added, the dashes dropped, every word
    // inflected differently.
    const roll = random();
    const misspelt = Math.floor(random() * words.length);
    const variant =
      roll < 0.05
        ? words.map((w, index) => (index === misspelt ? typo(random, w) : w))
        : roll < 0.1
          ? words.toReversed()
          : roll < 0.15
            ? [...words, word()]
            : roll < 0.2
              ? [words.join("")]
              : roll < 0.25
                ? words.map((w) => w.replace(/a$/, "o"))
                : null;
    if (variant !== null) {
      planted.push([slugs.length - 1, slugs.length]);
      slugs.push(variant.join("-"));
    }
  }
  return {
    candidates: slugs.slice(0, size).map((slug) => ({ slug, coverUrl: null })),
    planted: planted.filter(([, j]) => j < size),
  };
}

/**
 * Ten thousand titles are heavy on purpose, and a CI runner is several times
 * slower than a laptop (10 s on GitHub's macOS where a local run takes 1.6):
 * the default 5 s timeout would measure the runner, not the code. How fast the
 * blocking itself is, is what the second test asserts.
 */
const AT_SCALE_TIMEOUT_MS = 60_000;

describe("candidatePairs at scale", () => {
  it(
    "never loses a title's variant, with the frequency cap in play",
    () => {
      const { candidates, planted } = corpusAtScale(10_000, 11);
      const kept = new Set(
        candidatePairs(candidates).map(([i, j]) => `${i}:${j}`),
      );

      const missed = planted
        .filter(([i, j]) =>
          isPair(candidates[i] as Candidate, candidates[j] as Candidate),
        )
        .filter(([i, j]) => !kept.has(`${i}:${j}`))
        .map(([i, j]) => `${candidates[i]?.slug} ~ ${candidates[j]?.slug}`);

      expect(planted.length).toBeGreaterThan(1000);
      expect(missed).toEqual([]);
    },
    AT_SCALE_TIMEOUT_MS,
  );

  it(
    "keeps the work near-linear: ten thousand titles in seconds, not hours",
    () => {
      const { candidates } = corpusAtScale(10_000, 12);

      const start = performance.now();
      const pairs = candidatePairs(candidates);
      const elapsed = performance.now() - start;

      // A full comparison would be 50 million pairs. Under a second on a
      // laptop; the bound leaves room for a slow runner, not for quadratic work.
      expect(pairs.length).toBeLessThan(2_000_000);
      expect(elapsed).toBeLessThan(5_000);
    },
    AT_SCALE_TIMEOUT_MS,
  );
});

describe("blockingKeys", () => {
  it("files two words one edit apart under a shared key", () => {
    const keysA = new Set(blockingKeys("dragona"));
    const shared = blockingKeys("dragon").filter((key) => keysA.has(key));

    expect(shared.length).toBeGreaterThan(0);
  });
});
