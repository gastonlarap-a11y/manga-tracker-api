/**
 * Putting a value into another language's syntax without it being read as
 * syntax. Both of these take paths that come from the machine — a home
 * directory, a user name — which is to say from whoever named their account.
 */

/**
 * Text content of an XML element. Quotes need no escaping there; `&`, `<` and
 * `>` do, and an unescaped `&` in a path makes the whole document invalid.
 */
export const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

/**
 * A PowerShell single-quoted string literal. Inside one, nothing is expanded
 * and the only character that needs escaping is `'` itself, which doubles. A
 * path under C:\Users\O'Brien used to end the literal early and turn the rest
 * of the command into a syntax error.
 */
export const psSingleQuoted = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;
