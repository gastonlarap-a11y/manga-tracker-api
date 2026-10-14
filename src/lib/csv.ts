// RFC 4180 records, written for the two kinds of reader a library export has:
// a spreadsheet someone opens, and another tracker importing it by title.

/**
 * Excel reads a CSV without it as the machine's legacy code page, so every
 * accented title arrives garbled; importers that do not want it strip it.
 */
export const CSV_BOM = "﻿";

/**
 * A spreadsheet runs a cell starting with one of these as a formula, and a
 * title is whatever the reading site's page said — `=HYPERLINK(...)` included.
 * OWASP's mitigation: a leading apostrophe makes it text. The cost is that one
 * apostrophe on a title that really starts with "-" or "=".
 */
const FORMULA_TRIGGERS = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** Quoted only when it has to be, inner quotes doubled. */
export function csvField(value: string): string {
  const text = FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One record, CRLF-terminated as the RFC writes it. */
export function csvRecord(fields: readonly string[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}
