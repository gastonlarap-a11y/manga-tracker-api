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
import type { EnvLine } from "./env-file";

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
// .env files: the format lives in ./env-file, which the shipped bundles use
// without this manifest. Re-exported so the operator scripts keep one import.
// ---------------------------------------------------------------------------

export {
  type EnvLine,
  envValues,
  parseEnvFile,
  serializeEnvFile,
  serializeValue,
} from "./env-file";

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
