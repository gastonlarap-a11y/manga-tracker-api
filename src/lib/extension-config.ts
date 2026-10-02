/**
 * What the extension can be told about detection without a new version of it.
 *
 * Same reason `site-rules.ts` lives here: the extension goes through the Chrome
 * Web Store, and every change made there waits for a review, while this file
 * reaches a machine with the next desktop release. The difference is scope —
 * a site rule is about one site, this is about all of them.
 *
 * **Data, never code.** Manifest V3 forbids an extension from running code it
 * did not ship with, and the Web Store enforces it. Everything here is a
 * number, a word, a regex or a CSS selector that the extension's own compiled
 * code interprets; nothing here is evaluated.
 *
 * **Overrides and additions, never a copy of the defaults.** The defaults live
 * once, compiled into the extension, and keep working with no backend at all.
 * A number here replaces its default; a list here is added to the compiled one.
 * Two copies of the vocabulary — one here, one there — would drift, and the
 * extension's tests, which are what prove the heuristic, only see theirs.
 */

/** The shape `GET /api/extension-config` serves. Bumped on a breaking change. */
export const EXTENSION_CONFIG_SCHEMA_VERSION = 1;

/**
 * Tuning for the generic heuristic, applied on every site.
 *
 * A number left out (`undefined`) keeps the extension's compiled default. A
 * list is added to the compiled one: the defaults have been measured against
 * real reading history, and a remote edit that could remove one could stop
 * every site at once.
 */
export type DetectionTuning = {
  /** Auto-send threshold, 0–1. The compiled default is 0.7. */
  confidenceThreshold?: number;
  /** How long a page is given to finish rendering, in ms. Default 2000. */
  settleDelayMs?: number;
  /**
   * Regexes against the URL path naming a chapter, group 1 its number
   * (`/episodio-(\\d+)`). Each also marks the page as a chapter page.
   */
  chapterUrlPatterns: readonly string[];
  /** Regexes against the URL path of a reader page carrying no number. */
  readerPathPatterns: readonly string[];
  /** Words a title names a chapter with ("episodio"), matched before a number. */
  chapterWords: readonly string[];
  /** Path segments that name a site section, never a series ("novela"). */
  sectionSegments: readonly string[];
  /** Leading title words a site prepends to the name ("lee", "manhua"). */
  leadingPrefixes: readonly string[];
};

/**
 * A site theme many unrelated sites are built on, recognised by markup the
 * theme always emits.
 *
 * Measured from the sources of 105 Spanish-language sites (Keiyoushi's
 * extension catalogue): 30 run Madara, 14 MangaThemesia, 4 ZeistManga. A theme
 * the extension knows is a site it reads correctly the first time someone
 * opens it, calibration-free.
 *
 * Selectors are read on a chapter page. A theme is only ever a hint below a
 * calibration and a site's own rule: the heuristic still decides, with these
 * as better evidence than it could find alone.
 */
export type SiteTheme = {
  /** Lowercase identifier, shown in the popup when it applies. */
  name: string;
  /** Present on a chapter page of this theme, and on nothing else. */
  readerMarker: string;
  /** An element whose text names the series and the chapter. */
  headingSelector?: string;
  /** Anchors back to the series page; the last one off this page is taken. */
  seriesLinkSelector?: string;
  /** The anchor to the next chapter. */
  nextSelector?: string;
};

/** A message the popup shows until it is dismissed. */
export type ExtensionNotice = {
  /** Stable: a dismissed notice stays dismissed by its id. */
  id: string;
  level: "info" | "warning";
  /** Spanish, like every other word the user reads. */
  text: string;
};

export type ExtensionCatalogue = {
  /**
   * The oldest extension version that understands this catalogue. One older
   * still works — it ignores what it does not know — and the popup offers the
   * update.
   */
  minExtensionVersion: string;
  detection: DetectionTuning;
  themes: readonly SiteTheme[];
  notices: readonly ExtensionNotice[];
};

export const EXTENSION_CATALOGUE: ExtensionCatalogue = {
  minExtensionVersion: "0.2.0",
  detection: {
    chapterUrlPatterns: [],
    readerPathPatterns: [],
    chapterWords: [],
    sectionSegments: [],
    leadingPrefixes: [],
  },
  themes: [
    {
      // WP-Manga. The reader container is emitted by the theme's chapter
      // template only; the breadcrumb ends Home › (Manga ›) Series › Chapter.
      name: "madara",
      readerMarker: ".wp-manga-chapter-img, .reading-content .page-break",
      headingSelector: "#chapter-heading",
      seriesLinkSelector: ".breadcrumb li a",
      nextSelector: ".nav-next a.next_page, a.next_page",
    },
    {
      // The reader area and the "all chapters are in" link back to the series
      // are both theme markup.
      name: "mangathemesia",
      readerMarker: "#readerarea",
      headingSelector: "h1.entry-title",
      seriesLinkSelector: ".allc a, .ts-breadcrumb li a",
      nextSelector: ".ch-next-btn:not(.disabled), a[rel='next']",
    },
  ],
  notices: [],
};
