/**
 * Merged mangas form groups: one canonical row plus the aliases that point at
 * it through mergedIntoSlug. Resolving those pointers is pure set logic over
 * rows the caller already loaded, so it lives here with the other pure helpers
 * and can be shared by library, events and duplicates without any of those
 * modules importing each other.
 *
 * Why merging is a pointer and not a move: reassigning ReadingEvent.mangaId
 * would be an UPDATE on the append-only log. Nothing is ever moved — the group
 * is resolved at read time and the events stay exactly where they were written.
 */

/** The three columns group resolution needs; callers pass their full rows. */
export interface GroupMember {
  id: string;
  normalizedSlug: string;
  mergedIntoSlug: string | null;
}

export interface MangaGroup<T extends GroupMember> {
  /** The row that owns the card: metadata, cover, status and tags come from it. */
  canonical: T;
  /** Absorbed rows, invisible on their own but contributing their events. */
  aliases: T[];
  /** canonical.id first, then every alias id — for `where: { mangaId: { in } }`. */
  memberIds: string[];
}

// A chain deeper than this can only come from a bug or from two machines
// merging in opposite directions; walking it further is never useful.
const MAX_HOPS = 16;

/**
 * Follows mergedIntoSlug to the row that owns the card.
 *
 * Degrades instead of throwing, because both bad cases are reachable in normal
 * operation on a machine that synced halfway:
 * - a pointer to a slug that does not exist locally yet (the peer's manga has
 *   not arrived): the row is its own canonical for now, and the next sync fixes
 *   it. The stored value is never cleared — see the note in sync.mapper.ts.
 * - a cycle (two machines merged A into B and B into A before converging):
 *   the walk stops and the starting row is treated as canonical, so a request
 *   can never hang on it.
 */
export function resolveCanonical<T extends GroupMember>(
  manga: T,
  bySlug: ReadonlyMap<string, T>,
): T {
  const seen = new Set<string>([manga.normalizedSlug]);
  let current = manga;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (current.mergedIntoSlug === null) {
      return current;
    }
    const next = bySlug.get(current.mergedIntoSlug);
    // Dangling pointer: the target has not synced in yet.
    if (next === undefined) {
      return current;
    }
    // Cycle: fall back to where the walk started rather than loop forever.
    if (seen.has(next.normalizedSlug)) {
      return manga;
    }
    seen.add(next.normalizedSlug);
    current = next;
  }
  return manga;
}

export function indexBySlug<T extends GroupMember>(
  mangas: readonly T[],
): Map<string, T> {
  return new Map(mangas.map((manga) => [manga.normalizedSlug, manga]));
}

/**
 * Collapses a flat list of mangas into one group per canonical row. Groups come
 * back in the order their canonical appeared in the input, so callers keep
 * whatever ordering they asked the database for.
 */
export function resolveMangaGroups<T extends GroupMember>(
  mangas: readonly T[],
): MangaGroup<T>[] {
  const bySlug = indexBySlug(mangas);
  const groups = new Map<string, MangaGroup<T>>();

  // Canonicals first, so a group always exists before its aliases land in it
  // and the output keeps the input's ordering of canonical rows.
  for (const manga of mangas) {
    if (resolveCanonical(manga, bySlug).id === manga.id) {
      groups.set(manga.id, {
        canonical: manga,
        aliases: [],
        memberIds: [manga.id],
      });
    }
  }
  for (const manga of mangas) {
    const canonical = resolveCanonical(manga, bySlug);
    if (canonical.id === manga.id) {
      continue;
    }
    const group = groups.get(canonical.id);
    // Unreachable while both rows come from the same query, but a caller that
    // filtered the canonical out (e.g. by deletedAt) must not lose the alias.
    if (group === undefined) {
      groups.set(manga.id, {
        canonical: manga,
        aliases: [],
        memberIds: [manga.id],
      });
      continue;
    }
    group.aliases.push(manga);
    group.memberIds.push(manga.id);
  }

  return [...groups.values()];
}

/**
 * The pair key used by DuplicateDismissal: two slugs, always in the same order,
 * so that dismissing (a,b) also dismisses (b,a) — on this machine and on every
 * peer that receives the row.
 */
export function dismissalKey(
  slugA: string,
  slugB: string,
): { slugA: string; slugB: string } {
  const [first, second] = [slugA, slugB].toSorted();
  return { slugA: first, slugB: second };
}
