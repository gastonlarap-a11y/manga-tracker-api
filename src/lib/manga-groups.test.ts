import { describe, expect, it } from "bun:test";
import {
  dismissalKey,
  indexBySlug,
  resolveCanonical,
  resolveMangaGroups,
} from "./manga-groups";

function manga(slug: string, mergedIntoSlug: string | null = null) {
  return { id: `id-${slug}`, normalizedSlug: slug, mergedIntoSlug };
}

describe("resolveCanonical", () => {
  it("returns the row itself when it is canonical", () => {
    const rows = [manga("one-piece")];
    expect(resolveCanonical(rows[0], indexBySlug(rows)).id).toBe(
      "id-one-piece",
    );
  });

  it("follows a pointer to the canonical row", () => {
    const rows = [manga("dragon-a"), manga("dragon-b", "dragon-a")];
    expect(resolveCanonical(rows[1], indexBySlug(rows)).id).toBe("id-dragon-a");
  });

  it("walks a chain that was persisted before flattening existed", () => {
    const rows = [manga("a"), manga("b", "a"), manga("c", "b")];
    expect(resolveCanonical(rows[2], indexBySlug(rows)).id).toBe("id-a");
  });

  it("treats a pointer to an unknown slug as canonical", () => {
    // Reachable for real: a peer merged into a manga this machine has not
    // pulled yet. The row must still be usable, and the value is kept.
    const rows = [manga("local", "not-synced-yet")];
    const resolved = resolveCanonical(rows[0], indexBySlug(rows));
    expect(resolved.id).toBe("id-local");
    expect(resolved.mergedIntoSlug).toBe("not-synced-yet");
  });

  it("does not hang on a cycle", () => {
    const rows = [manga("a", "b"), manga("b", "a")];
    const bySlug = indexBySlug(rows);
    expect(resolveCanonical(rows[0], bySlug).id).toBe("id-a");
    expect(resolveCanonical(rows[1], bySlug).id).toBe("id-b");
  });

  it("does not hang on a self-reference", () => {
    const rows = [manga("a", "a")];
    expect(resolveCanonical(rows[0], indexBySlug(rows)).id).toBe("id-a");
  });
});

describe("resolveMangaGroups", () => {
  it("returns one group per manga when nothing is merged", () => {
    const groups = resolveMangaGroups([manga("one-piece"), manga("berserk")]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.aliases.length === 0)).toBe(true);
  });

  it("collapses aliases into their canonical and lists every member id", () => {
    const groups = resolveMangaGroups([
      manga("dragon-a"),
      manga("dragon-b", "dragon-a"),
      manga("dragon-c", "dragon-a"),
      manga("berserk"),
    ]);

    expect(groups).toHaveLength(2);
    const dragon = groups[0];
    expect(dragon.canonical.id).toBe("id-dragon-a");
    expect(dragon.aliases.map((alias) => alias.id)).toEqual([
      "id-dragon-b",
      "id-dragon-c",
    ]);
    expect(dragon.memberIds).toEqual([
      "id-dragon-a",
      "id-dragon-b",
      "id-dragon-c",
    ]);
  });

  it("keeps the input ordering of canonical rows", () => {
    const groups = resolveMangaGroups([
      manga("berserk"),
      manga("dragon-b", "dragon-a"),
      manga("dragon-a"),
    ]);
    expect(groups.map((group) => group.canonical.normalizedSlug)).toEqual([
      "berserk",
      "dragon-a",
    ]);
  });

  it("never drops an alias whose canonical is missing from the input", () => {
    const groups = resolveMangaGroups([manga("orphan", "filtered-out")]);
    expect(groups).toHaveLength(1);
    expect(groups[0].canonical.id).toBe("id-orphan");
  });
});

describe("dismissalKey", () => {
  it("orders the pair so (a,b) and (b,a) are the same row", () => {
    expect(dismissalKey("zeta", "alpha")).toEqual(
      dismissalKey("alpha", "zeta"),
    );
    expect(dismissalKey("zeta", "alpha")).toEqual({
      slugA: "alpha",
      slugB: "zeta",
    });
  });
});
