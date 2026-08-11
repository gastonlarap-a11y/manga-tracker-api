import { describe, expect, it } from "bun:test";
import { seriesKeyFromUrl } from "./normalize";
import {
  ruleFor,
  SITE_RULES,
  type SiteRule,
  seriesUrlFromRule,
} from "./site-rules";

/** The catalogue entry a test is about; missing it is a failure, not a case. */
function ruleOf(host: string): SiteRule {
  const rule = ruleFor(host);
  if (rule === null) {
    throw new Error(`the catalogue has no rule for ${host}`);
  }
  return rule;
}

/** The identity a chapter URL ends up with, exactly as ingestion computes it. */
function keyOf(url: string): string | null {
  const host = new URL(url).hostname;
  const rule = ruleFor(host);
  if (rule === null) {
    return null;
  }
  const seriesUrl = seriesUrlFromRule(rule, url);
  return seriesUrl === null ? null : seriesKeyFromUrl(seriesUrl);
}

describe("ruleFor", () => {
  it("finds a rule by host, ignoring www and case", () => {
    expect(ruleFor("manhwaweb.com")?.domain).toBe("manhwaweb.com");
    expect(ruleFor("www.manhwaweb.com")?.domain).toBe("manhwaweb.com");
    expect(ruleFor("MANHWAWEB.COM")?.domain).toBe("manhwaweb.com");
  });

  it("has no rule for the sites the generic heuristic already reads", () => {
    // Present here would be worse than absent: the extension's own path rule
    // already keys these, and on mhscans it agrees with the page's anchor.
    expect(ruleFor("lectorxd.com")).toBeNull();
    expect(ruleFor("mhscans.com")).toBeNull();
  });

  it("does not match a different site that merely ends the same way", () => {
    expect(ruleFor("notmanhwaweb.com")).toBeNull();
  });
});

describe("manhwaweb.com", () => {
  it("gives one key for every chapter of a series", () => {
    // Real URLs. The chapter and its part vary; the slug and epoch do not.
    const chapters = [
      "https://manhwaweb.com/leer/el-terrateniente-que-inicio-con--habitantes_1783153660799-5_01",
      "https://manhwaweb.com/leer/el-terrateniente-que-inicio-con--habitantes_1783153660799-9_01",
      "https://manhwaweb.com/leer/el-terrateniente-que-inicio-con--habitantes_1783153660799-10_01",
    ].map(keyOf);

    expect(chapters[0]).toBe(
      "manhwaweb.com/leer/el-terrateniente-que-inicio-con--habitantes_1783153660799",
    );
    expect(new Set(chapters).size).toBe(1);
  });

  it("keeps a slug that contains underscores intact", () => {
    // "emperador_mágico" — the separator before the epoch is the same character
    // the slug itself uses, so the split has to be anchored on the digits.
    expect(
      keyOf("https://manhwaweb.com/leer/emperador_magico_1703957316968-882_01"),
    ).toBe("manhwaweb.com/leer/emperador_magico_1703957316968");
  });

  it("never gives two series the same key", () => {
    expect(
      keyOf(
        "https://manhwaweb.com/leer/puedo-destruir-los--mundos-con-un-cuchillo-carnicero_1750256573107-36_01",
      ),
    ).not.toBe(
      keyOf(
        "https://manhwaweb.com/leer/un-nio-criado-por-un-rey-demonio_1742223256781-55",
      ),
    );
  });

  it("refuses a URL with no chapter to split on", () => {
    const rule = ruleOf("manhwaweb.com");
    // A series page, or anything else: no chapter suffix, so nothing to derive.
    expect(
      seriesUrlFromRule(rule, "https://manhwaweb.com/manga/dragona"),
    ).toBeNull();
    expect(seriesUrlFromRule(rule, "https://manhwaweb.com/leer/")).toBeNull();
  });
});

describe("olympusxyz.com", () => {
  it("strips the per-chapter timestamp so a series keeps one key", () => {
    // The same manga, four chapters, four timestamps — measured from real data.
    const chapters = [
      "https://olympusxyz.com/capitulo/130756/comic-como-criar-villanos-correctamente-20260716-110408156",
      "https://olympusxyz.com/capitulo/131002/comic-como-criar-villanos-correctamente-20260723-110159729",
      "https://olympusxyz.com/capitulo/131300/comic-como-criar-villanos-correctamente-20260730-110448843",
      "https://olympusxyz.com/capitulo/131588/comic-como-criar-villanos-correctamente-20260806-110528441",
    ].map(keyOf);

    expect(chapters[0]).toBe(
      "olympusxyz.com/comic-como-criar-villanos-correctamente",
    );
    expect(new Set(chapters).size).toBe(1);
  });

  it("leaves a slug that carries no timestamp alone", () => {
    expect(
      keyOf(
        "https://olympusxyz.com/capitulo/127213/comic-el-retornado-quiere-una-vida-tranquila",
      ),
    ).toBe("olympusxyz.com/comic-el-retornado-quiere-una-vida-tranquila");
  });

  it("keeps a slug whose own text contains digits and dashes", () => {
    // This site mangles some slugs ("de-duen10-05-2025de-a-dios-goblin"); the
    // damage is stable per series, so it must survive untouched.
    const chapters = [
      "https://olympusxyz.com/capitulo/127103/comic-de-duen10-05-2025de-a-dios-goblin",
      "https://olympusxyz.com/capitulo/128179/comic-de-duen10-05-2025de-a-dios-goblin",
    ].map(keyOf);

    expect(chapters[0]).toBe(
      "olympusxyz.com/comic-de-duen10-05-2025de-a-dios-goblin",
    );
    expect(new Set(chapters).size).toBe(1);
  });

  it("never gives two series the same key", () => {
    expect(
      keyOf(
        "https://olympusxyz.com/capitulo/126590/comic-ingeniero-de-laberintos-de-rango-nacional",
      ),
    ).not.toBe(
      keyOf(
        "https://olympusxyz.com/capitulo/130182/comic-mi-vida-cuidando-dragonas-20260708-080309818",
      ),
    );
  });

  it("refuses a chapter URL with no series slug in it", () => {
    const rule = ruleOf("olympusxyz.com");
    // Keying this by the chapter id would give every chapter its own series.
    expect(
      seriesUrlFromRule(rule, "https://olympusxyz.com/capitulo/130729/"),
    ).toBeNull();
  });
});

describe("the catalogue as a whole", () => {
  it("declares every composed identity as not navigable", () => {
    // Both rules assemble an address the site never published. Saying otherwise
    // would send the cover hunt to fetch a 404 and read it as "no cover".
    for (const rule of SITE_RULES) {
      expect(rule.series.navigable).toBe(false);
    }
  });

  it("carries a usable pattern and a note for every site", () => {
    for (const rule of SITE_RULES) {
      expect(() => new RegExp(rule.series.pattern)).not.toThrow();
      expect(rule.series.template).toContain("$1");
      expect(rule.note.length).toBeGreaterThan(0);
    }
  });

  it("lists each domain once", () => {
    const domains = SITE_RULES.map((rule) => rule.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });
});
