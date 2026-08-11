/**
 * Normalizes a manga title into a standardized slug for deduplication.
 */
export function normalizeSlug(name: string): string {
  if (typeof name !== "string" || !name.trim()) {
    return "";
  }
  let slug = name.toLowerCase();
  slug = slug.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  slug = slug.replace(/[^a-z0-9\s-]/g, " ");
  slug = slug.trim().replace(/[\s-]+/g, "-");
  const stopWordsRegex = /-(manga|manhwa|manhua|comic|novel)$/;
  while (stopWordsRegex.test(slug)) {
    slug = slug.replace(stopWordsRegex, "");
  }
  return slug.length > 0 ? slug : "unknown-title";
}

/**
 * Extracts a numeric chapter value from a raw chapter string.
 * Domain logic utility - Pure function.
 */
export function parseChapterNumber(text: string): number | null {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  const match = text.match(/\d+(\.\d+)?/);
  if (!match) {
    return null;
  }
  const chapterNumber = parseFloat(match[0]);
  return Number.isNaN(chapterNumber) ? null : chapterNumber;
}

/**
 * Identity of a series WITHIN one site: host + path of its series page, with
 * the trailing slash, query and hash dropped so the same page always produces
 * the same key.
 *
 * This is what a title cannot give: sites reformat their <title> (adding the
 * chapter, the scanlation group, a tagline), and every reformat used to mint a
 * second manga for a series already in the library. The series path does not
 * move. Derived by the server, never taken from the client, like the slug and
 * the domain.
 *
 * Null for an unusable URL or a bare origin — a site root identifies nothing.
 */
export function seriesKeyFromUrl(seriesUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(seriesUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path === "") {
    return null;
  }
  return `${url.hostname.toLowerCase()}${path.toLowerCase()}`;
}

/**
 * Identity of a chapter within one series: the parsed number when there is one
 * ("Cap. 49" and "Chapter 49" are the same chapter), the exact label otherwise.
 *
 * Shared so that "already read" means the same thing in the two places that
 * decide it: the ingestion, which refuses to append a chapter already in the
 * history, and the library projection, which must not show a chapter twice
 * after two sites for the same series were merged into one card.
 */
export function chapterKey(chapter: {
  chapterNumber: number | null;
  chapterLabel: string;
}): string {
  return chapter.chapterNumber !== null
    ? `n:${chapter.chapterNumber}`
    : `l:${chapter.chapterLabel}`;
}

/**
 * Whether a reported title is just the site naming itself.
 *
 * A Cloudflare interstitial is served on the chapter's own URL, with the
 * hostname as its only heading and no og/twitter tags, so a detector has
 * nothing left to tell it apart from a manga name. That is how "lectorxd.com"
 * became a card that two unrelated series were then filed under: without a
 * series key, the title IS the identity, so a bad title does not produce one
 * junk card — it merges whatever arrives while the challenge is up.
 *
 * Refused here rather than in the extension because the browser holds whichever
 * version it last updated to, and this has to hold for the ones already out
 * there. The reading is not lost: the challenge clears, the real page loads,
 * and the detector reports it again.
 *
 * Compared on normalized slugs, so "LectorXD.com" and "www.lectorxd.com"
 * collapse onto the same thing. Deliberately narrow: only the full hostname
 * counts, never the bare brand without its TLD. Nothing is named "something dot
 * com", while plenty of series could share a bare word with the site hosting
 * them.
 */
export function isSiteNameTitle(mangaName: string, sourceUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    // An unparseable source URL is the request schema's problem, not this one's.
    return false;
  }
  const hostname = url.hostname.replace(/^www\./i, "");
  const hostSlug = normalizeSlug(hostname);
  // normalizeSlug never returns "" (it falls back to "unknown-title"), so a
  // title of pure punctuation could otherwise match a hostname of the same.
  return hostSlug !== "unknown-title" && normalizeSlug(mangaName) === hostSlug;
}
