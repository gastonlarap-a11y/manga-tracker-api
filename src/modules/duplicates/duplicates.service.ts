import { prisma } from "../../db/client";
import type { Manga } from "../../generated/prisma/client";
import { levenshteinSimilarity } from "../../lib/similarity";

// Domain policy: pairs at or above this similarity are surfaced as suspected
// duplicates. Detection only — merging would move events (an UPDATE), which
// the append-only rule forbids; fixes happen by hand via PUT /api/mangas/:id.
const SIMILARITY_THRESHOLD = 0.85;

export interface DuplicatePair {
  a: Manga;
  b: Manga;
  similarity: number;
}

export async function findDuplicatePairs(): Promise<DuplicatePair[]> {
  const mangas = await prisma.manga.findMany({
    // A deleted manga is not a duplicate candidate; its row only lingers so
    // the deletion can reach the other machines.
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
  });

  // O(n²) over tens of mangas — sub-millisecond, not worth anything smarter.
  const pairs: DuplicatePair[] = [];
  for (let i = 0; i < mangas.length; i++) {
    for (let j = i + 1; j < mangas.length; j++) {
      const similarity = levenshteinSimilarity(
        mangas[i].normalizedSlug,
        mangas[j].normalizedSlug,
      );
      if (similarity >= SIMILARITY_THRESHOLD) {
        pairs.push({ a: mangas[i], b: mangas[j], similarity });
      }
    }
  }

  return pairs.toSorted((x, y) => y.similarity - x.similarity);
}
