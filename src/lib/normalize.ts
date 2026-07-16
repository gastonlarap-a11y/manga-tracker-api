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
