/**
 * `.env` parsing and serialization — and nothing else.
 *
 * A module of its own so the shipped bundles can read and write `prod.env`
 * without taking the manifest along: `deploy/lib/windows.ts` needs these
 * functions and is bundled into `service.js` and `launch.js`, and when they
 * lived in `env.ts` the manifest came with them — the Key Vault secret name,
 * the dev database name and the author's notes, in the payload someone else
 * installs. Nothing here may import `./env`.
 */

/**
 * A `.env` is kept as lines rather than a map so rewriting it preserves the
 * comments, the ordering and — most importantly — any variable this manifest
 * does not know about. A pull must never silently drop something you added by
 * hand.
 */
export type EnvLine =
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "entry"; readonly key: string; readonly value: string };

const ENTRY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * Undoes the quoting rules Bun applies when it loads a `.env`. Verified
 * against Bun directly: `$` expands even inside single quotes, an unquoted `#`
 * starts a comment, and `\$` is the only escape that survives.
 */
function parseValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
    return trimmed.slice(1, -1).replaceAll("\\$", "$");
  }
  const uncommented = trimmed.split("#")[0] ?? "";
  return uncommented.trim().replaceAll("\\$", "$");
}

export function parseEnvFile(text: string): EnvLine[] {
  // No file yet is no lines, not one empty line: otherwise a freshly created
  // .env opens with stray blanks before the first comment.
  if (text === "") {
    return [];
  }
  return text
    .split("\n")
    .slice(0, text.endsWith("\n") ? -1 : undefined)
    .map((line): EnvLine => {
      const match = ENTRY.exec(line);
      const value = match?.[2];
      return match?.[1] === undefined || value === undefined
        ? { kind: "raw", text: line }
        : { kind: "entry", key: match[1], value: parseValue(value) };
    });
}

/**
 * Bun expands `$` in every quoting style, so the only safe form is double
 * quotes with `$` escaped. It does NOT unescape `\"` or `\\` — those come back
 * with the backslash still attached — so a value containing either cannot be
 * round-tripped and we refuse to write it. Corrupting a credential silently is
 * far worse than stopping. A Mongo URI percent-encodes both anyway.
 */
export function serializeValue(key: string, value: string): string {
  if (value.includes('"') || value.includes("\\")) {
    throw new Error(
      `${key} contains a quote or backslash, which Bun cannot read back from a .env file. ` +
        "Percent-encode it in the connection string.",
    );
  }
  return `"${value.replaceAll("$", "\\$")}"`;
}

export function serializeEnvFile(lines: readonly EnvLine[]): string {
  const body = lines
    .map((line) =>
      line.kind === "raw"
        ? line.text
        : `${line.key}=${serializeValue(line.key, line.value)}`,
    )
    .join("\n");
  return body === "" ? "" : `${body}\n`;
}

export function envValues(
  lines: readonly EnvLine[],
): ReadonlyMap<string, string> {
  return new Map(
    lines
      .filter(
        (line): line is EnvLine & { kind: "entry" } => line.kind === "entry",
      )
      .map((line) => [line.key, line.value]),
  );
}
