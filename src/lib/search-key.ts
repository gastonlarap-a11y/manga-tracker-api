/**
 * A title as search and A–Z ordering see it: lowercase, accents stripped, so
 * "invocacion" finds "Invocación" and "Ásura" sorts beside "Asura". The same
 * rule the dashboard applied in the browser while it held the whole library;
 * now the server holds it, so it lives here.
 */

// U+0300–U+036F, the combining diacritical marks NFD splits accents into.
// Built from code points because the marks themselves are invisible in source.
const COMBINING_MARKS = new RegExp(
  `[${String.fromCodePoint(0x300)}-${String.fromCodePoint(0x36f)}]`,
  "g",
);

export function searchKeyOf(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .trim();
}
