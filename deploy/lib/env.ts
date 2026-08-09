/**
 * What every environment variable is, and where its value comes from.
 *
 * The point of the manifest is that only ONE of these is a shared secret. The
 * rest are either the same everywhere or specific to the machine, so pushing a
 * whole `.env` to the cloud would upload a `DATABASE_URL` holding an absolute
 * path that is wrong on any other Mac. Adding a variable later is one entry
 * here, not an edit in four scripts.
 */

// The one import from src/: the default extension ids have to be the same
// values the server falls back to, and two copies of a 32-character literal
// drift exactly once — the day the extension goes silent for no visible reason.
import { DEFAULT_EXTENSION_IDS } from "../../src/lib/cors";

export type Profile = "dev" | "prod";

export type EnvSpec = {
  readonly name: string;
  /** Rendered above the entry when the file is written. */
  readonly comment: string;
} & (
  | { readonly kind: "secret"; readonly secretName: string }
  | { readonly kind: "profile"; readonly dev: string; readonly prod: string }
  | {
      readonly kind: "machine";
      readonly resolve: (
        home: string,
        profile: Profile,
        platform: NodeJS.Platform,
      ) => string;
    }
);

export const ENV_MANIFEST: readonly EnvSpec[] = [
  {
    name: "DATABASE_URL",
    kind: "machine",
    comment:
      "SQLite file. Dev keeps its own so running the server never touches production data.",
    resolve: (home, profile, platform) => {
      if (profile !== "prod") {
        return "file:./dev.db";
      }
      // libsql's `file:` parser keeps the path raw (no triple-slash required),
      // so a forward-slashed Windows path round-trips fine.
      return platform === "win32"
        ? `file:${home.replaceAll("\\", "/")}/AppData/Local/MangaTracker/mangatracker.db`
        : `file:${home}/Library/Application Support/MangaTracker/mangatracker.db`;
    },
  },
  {
    name: "PORT",
    kind: "profile",
    comment:
      "Dev and prod share the port on purpose: bootout the LaunchAgent to free it for `bun run dev`.",
    dev: "5150",
    prod: "5150",
  },
  {
    name: "EXTENSION_IDS",
    kind: "profile",
    comment:
      "Extension ids allowed through CORS, comma separated: the Web Store build and the unpacked one, so both reach the backend during an update.",
    dev: DEFAULT_EXTENSION_IDS.join(","),
    prod: DEFAULT_EXTENSION_IDS.join(","),
  },
  {
    name: "MONGODB_URL",
    kind: "secret",
    comment:
      "Azure DocumentDB connection string. Unset means the sync module stays inert.",
    secretName: "mangatracker-mongodb-url",
  },
  {
    name: "MONGODB_DB",
    kind: "profile",
    comment: "Dev syncs somewhere harmless instead of into the shared library.",
    dev: "mangatracker_dev",
    prod: "mangatracker",
  },
];

export const secretSpecs = (): readonly (EnvSpec & { kind: "secret" })[] =>
  ENV_MANIFEST.filter(
    (spec): spec is EnvSpec & { kind: "secret" } => spec.kind === "secret",
  );

/**
 * The value for a spec under a profile. Secrets are not derivable — the caller
 * resolves those from the Keychain or Key Vault and passes them in.
 */
export function resolveSpec(
  spec: EnvSpec,
  profile: Profile,
  home: string,
  secrets: ReadonlyMap<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | null {
  switch (spec.kind) {
    case "secret":
      return secrets.get(spec.secretName) ?? null;
    case "profile":
      return profile === "prod" ? spec.prod : spec.dev;
    case "machine":
      return spec.resolve(home, profile, platform);
  }
}

// ---------------------------------------------------------------------------
// .env parsing and serialization
// ---------------------------------------------------------------------------

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

/** Replaces the entry in place, keeping its position, or appends it with its comment. */
export function upsertEntry(
  lines: readonly EnvLine[],
  spec: EnvSpec,
  value: string,
): EnvLine[] {
  const index = lines.findIndex(
    (line) => line.kind === "entry" && line.key === spec.name,
  );
  if (index >= 0) {
    return lines.with(index, { kind: "entry", key: spec.name, value });
  }
  const spacer: EnvLine[] =
    lines.length === 0 ? [] : [{ kind: "raw", text: "" }];
  return [
    ...lines,
    ...spacer,
    { kind: "raw", text: `# ${spec.comment}` },
    { kind: "entry", key: spec.name, value },
  ];
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
