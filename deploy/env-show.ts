/**
 * Shows every profile in one place: what each variable resolves to, and whether
 * the files on this machine actually match.
 *
 * Read-only by construction — it writes nothing and never reaches the network.
 * Secrets are resolved from the plist and the Keychain only, and printed as a
 * short hash: enough to tell two machines apart or spot drift, safe to paste.
 *
 * Usage:
 *   bun run env:show
 */
import { homedir } from "node:os";
import { loadDeployConfig } from "./lib/config";
import {
  ENV_MANIFEST,
  type EnvSpec,
  envValues,
  type Profile,
  parseEnvFile,
  resolveSpec,
} from "./lib/env";
import { platform } from "./lib/platform";
import { spawnRunner } from "./lib/run";
import { heading, installErrorHandler, step, warn } from "./lib/ui";

installErrorHandler();

const run = spawnRunner;
const home = homedir();
const { vaultName } = await loadDeployConfig();

const short = (path: string) => path.replace(home, "~");
const digest = (value: string) =>
  `sha ${new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8)}`;

// --- secrets, from local sources only ---------------------------------------

const secrets = new Map<string, string>();
const secretReport = new Map<string, string[]>();

for (const spec of ENV_MANIFEST) {
  if (spec.kind !== "secret") {
    continue;
  }
  const fromConfig = await platform.readConfigEnv(run, spec.name);
  const fromCache = await platform.readSecret(run);
  const lines: string[] = [
    `${platform.configLabel.padEnd(10)}${fromConfig === null ? "—" : digest(fromConfig)}`,
    `${platform.secretCacheLabel.padEnd(10)}${fromCache === null ? "—" : digest(fromCache)}`,
  ];
  if (fromConfig !== null && fromCache !== null && fromConfig !== fromCache) {
    // Worth shouting about: the cascade prefers the config file, so a stale
    // cache is what a freshly wiped machine would silently recover.
    lines.push(
      `⚠ the ${platform.configLabel} and ${platform.secretCacheLabel} disagree — run \`bun run env:push\``,
    );
  }
  secretReport.set(spec.name, lines);
  const local = fromConfig ?? fromCache;
  if (local !== null) {
    secrets.set(spec.secretName, local);
  }
}

// --- the manifest -----------------------------------------------------------

heading("Profiles (deploy/lib/env.ts)");

for (const spec of ENV_MANIFEST) {
  const dev = resolveSpec(spec, "dev", home, secrets);
  const prod = resolveSpec(spec, "prod", home, secrets);

  if (spec.kind === "secret") {
    console.log(`\n${spec.name}  [secret]`);
    console.log(`  vault     ${vaultName} / ${spec.secretName}`);
    for (const line of secretReport.get(spec.name) ?? []) {
      console.log(`  ${line}`);
    }
    continue;
  }

  console.log(`\n${spec.name}  [${spec.kind}]`);
  if (dev === prod) {
    console.log(`  dev+prod  ${short(dev ?? "—")}`);
  } else {
    console.log(`  dev       ${short(dev ?? "—")}`);
    console.log(`  prod      ${short(prod ?? "—")}`);
  }
}

// --- what the files on disk actually hold -----------------------------------

/** Which manifest variables in `actual` differ from the profile's value. */
const compare = (
  actual: ReadonlyMap<string, string | null>,
  profile: Profile,
): { readonly missing: string[]; readonly stale: string[] } => {
  const missing: string[] = [];
  const stale: string[] = [];
  for (const spec of ENV_MANIFEST as readonly EnvSpec[]) {
    const expected = resolveSpec(spec, profile, home, secrets);
    const current = actual.get(spec.name) ?? null;
    if (current === null || current === "") {
      missing.push(spec.name);
    } else if (expected !== null && current !== expected) {
      stale.push(spec.name);
    }
  }
  return { missing, stale };
};

const report = (
  label: string,
  present: boolean,
  profile: Profile,
  actual: ReadonlyMap<string, string | null>,
) => {
  if (!present) {
    warn(`${label.padEnd(6)} absent`);
    return;
  }
  const { missing, stale } = compare(actual, profile);
  const total = ENV_MANIFEST.length;
  const ok = total - missing.length - stale.length;
  const notes = [
    missing.length > 0 ? `missing: ${missing.join(", ")}` : null,
    stale.length > 0 ? `differs from ${profile}: ${stale.join(", ")}` : null,
  ].filter((note) => note !== null);
  step(
    `${label.padEnd(6)} ${ok}/${total} match the ${profile} profile` +
      (notes.length > 0 ? ` · ${notes.join(" · ")}` : ""),
  );
};

heading("On disk");

const envFile = Bun.file(".env");
const envPresent = await envFile.exists();
const envMap: ReadonlyMap<string, string | null> = envPresent
  ? envValues(parseEnvFile(await envFile.text()))
  : new Map();
report(".env", envPresent, "dev", envMap);

const configPresent = await platform.configExists();
const configMap = new Map<string, string | null>();
if (configPresent) {
  for (const spec of ENV_MANIFEST) {
    configMap.set(spec.name, await platform.readConfigEnv(run, spec.name));
  }
}
report(platform.configLabel, configPresent, "prod", configMap);

console.log(`\n  .env   ./.env`);
console.log(
  `  ${platform.configLabel.padEnd(6)} ${short(platform.configPath)}`,
);
