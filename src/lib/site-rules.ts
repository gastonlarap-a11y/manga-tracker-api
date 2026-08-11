/**
 * What the extension needs to know about a site that its generic heuristics
 * cannot work out on their own.
 *
 * These live here, in the server, rather than inside the extension, and that is
 * the whole point: the extension is published through the Chrome Web Store, so
 * teaching it one new site used to cost a review — days of waiting for a regex.
 * The server ships with the desktop app instead, and reaches a machine the next
 * time it updates. Reading on a site nobody anticipated should not depend on
 * Google's queue.
 *
 * Curated here rather than stored in the database on purpose. A table would
 * have to be filled in by hand on every machine, would travel through the Mongo
 * sync as if it were the user's own reading history, and could not be tested.
 * A user's own calibration still wins over any of this — see
 * `modules/site-rules`, which merges the two.
 */

/**
 * How to derive the identity of a series from the URL of one of its chapters.
 *
 * The generic heuristic in the extension assumes the series slug sits in its
 * own path segment, before the chapter marker (`/manhua/<slug>/leer/56`). Sites
 * that break that assumption need to be told.
 */
export type SeriesRule = {
  /**
   * Matched against the full chapter URL. Group 1 is what identifies the
   * series; everything else in the URL is chapter-specific and must not end up
   * in the key, or every chapter would look like a different series.
   */
  pattern: string;
  /** Composes the series URL, with `$1` standing for the captured group. */
  template: string;
  /**
   * Whether the composed URL names a page that actually exists.
   *
   * False where the identity has to be assembled rather than found: enough to
   * key a series, but not something to fetch. The extension's cover hunt
   * downloads the series page looking for artwork, and asking a site for a URL
   * it never published wastes a request and, worse, reads as a site that has no
   * cover.
   */
  navigable: boolean;
};

export type SiteRule = {
  /** Hostname, without `www.`; matched against the page's own host. */
  domain: string;
  /** Why this site needs a rule at all. Read by whoever adds the next one. */
  note: string;
  series: SeriesRule;
};

/**
 * The sites whose URLs the generic heuristic cannot read.
 *
 * A site belongs here only when the heuristic gets it wrong or gives up —
 * lectorxd (`/manhua/<slug>/leer/56`) and mhscans (`/series/<slug>/capitulo-89/`)
 * are absent because it already handles them, and on mhscans it produces exactly
 * the same key the page's own anchor does.
 *
 * Every rule here was measured against real reading history before being added:
 * every chapter of a series must produce one key, and no two series may ever
 * produce the same one. A shared key merges unrelated series into one card and
 * is undone by hand.
 */
export const SITE_RULES: readonly SiteRule[] = [
  {
    domain: "manhwaweb.com",
    // A reader at the site root: `/leer/<slug>_<epoch>-<chapter>[_<part>]`, with
    // the series slug and the chapter fused into a single path segment. The
    // generic rule would have to cut at `/leer/`, which every series on the site
    // shares — one card for the whole site.
    //
    // The 13-digit epoch is what makes the split safe: a chapter number never
    // has that many digits, so the boundary cannot be mistaken for part of a
    // title that happens to end in a number ("temporada-2").
    note: "Series slug and chapter share one path segment, split by a 13-digit epoch",
    series: {
      pattern:
        "^https?://(?:www\\.)?manhwaweb\\.com/leer/(.+_\\d{10,})-\\d+(?:[.,]\\d+)?(?:_\\d+)?/?$",
      template: "https://manhwaweb.com/leer/$1",
      // `/leer/<slug>_<epoch>` without a chapter is not a page the site serves.
      navigable: false,
    },
  },
  {
    domain: "olympusxyz.com",
    // Inverted layout: `/capitulo/<id>/comic-<slug>`, with the chapter id
    // *before* the series. The generic rule stops at `/capitulo`, correctly
    // refusing to key a series by its chapter id.
    //
    // The trailing `-<YYYYMMDD>-<HHMMSSmmm>` is the chapter's publication
    // timestamp, not the series': one manga was found under four of them
    // (…-20260716-110408156, …-20260723-110159729, …) that collapse to a single
    // key once it is stripped.
    note: "Chapter id precedes the series slug, which carries a per-chapter timestamp",
    series: {
      pattern:
        "^https?://(?:www\\.)?olympusxyz\\.com/capitulo/\\d+/([^/?#]+?)(?:-\\d{8}-\\d{6,12})?/?$",
      template: "https://olympusxyz.com/$1",
      // Composed from a slug that lives under the chapter path; the site has no
      // page at this address.
      navigable: false,
    },
  },
];

/**
 * The rule for a host, or null when the generic heuristic is enough.
 *
 * Matches the registrable part too, so a site read on `www.` or on a regional
 * subdomain still finds its rule.
 */
export function ruleFor(
  host: string,
  rules: readonly SiteRule[] = SITE_RULES,
): SiteRule | null {
  const needle = host.toLowerCase().replace(/^www\./, "");
  return (
    rules.find(
      (rule) => needle === rule.domain || needle.endsWith(`.${rule.domain}`),
    ) ?? null
  );
}

/**
 * The series URL a rule derives from a chapter URL, or null when the rule does
 * not apply to it.
 *
 * Null rather than a guess, always: this feeds the series key, and a key two
 * series share is worse than no key at all.
 */
export function seriesUrlFromRule(rule: SiteRule, url: string): string | null {
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(rule.series.pattern, "i").exec(url);
  } catch {
    // A malformed pattern is a bug in the catalogue, not a reason to break
    // detection on the page the reader is looking at.
    return null;
  }
  const captured = match?.[1];
  if (!captured) {
    return null;
  }
  return rule.series.template.replace("$1", captured);
}
