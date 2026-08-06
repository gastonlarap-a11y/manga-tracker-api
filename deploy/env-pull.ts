/**
 * Materializes a working configuration on this machine: shared secrets come
 * down from Key Vault, everything else is derived from the manifest.
 *
 * This is what makes a freshly cloned repo runnable with no connection string
 * typed by hand.
 *
 * Usage:
 *   bun run env:pull            # writes .env for development
 *   bun run env:pull --prod     # writes the LaunchAgent plist for production
 */
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { flagValue, loadDeployConfig } from "./lib/config";
import {
  ENV_MANIFEST,
  type EnvLine,
  type Profile,
  parseEnvFile,
  resolveSpec,
  serializeEnvFile,
  upsertEntry,
} from "./lib/env";
import { platform } from "./lib/platform";
import { spawnRunner } from "./lib/run";
import { resolveSecret } from "./lib/secrets";
import { done, fail, heading, installErrorHandler, step, warn } from "./lib/ui";

installErrorHandler();

const args = process.argv.slice(2);
const profile: Profile = args.includes("--prod") ? "prod" : "dev";
const run = spawnRunner;
const home = homedir();

const { vaultName } = await loadDeployConfig(flagValue(args, "--vault"));

heading(`Pulling the ${profile} configuration`);

if (profile === "prod" && !(await platform.configExists())) {
  fail(
    `no ${platform.serviceKind} at ${platform.configPath}`,
    "Production is not installed on this machine yet. See .claude/skills/deploy/.",
  );
}

// --- resolve the shared secrets ---------------------------------------------

const secrets = new Map<string, string>();
for (const spec of ENV_MANIFEST) {
  if (spec.kind !== "secret") {
    continue;
  }
  const resolved = await resolveSecret(run, spec, {
    vault: vaultName,
    platform,
    onStep: step,
  });
  if (resolved === null) {
    warn(
      `${spec.name} could not be recovered — the sync module will stay disabled.`,
    );
    continue;
  }
  secrets.set(spec.secretName, resolved.value);
}

// --- write the target --------------------------------------------------------

if (profile === "prod") {
  for (const spec of ENV_MANIFEST) {
    const value = resolveSpec(spec, profile, home, secrets);
    if (value === null) {
      continue;
    }
    if (!(await platform.writeConfigEnv(run, spec.name, value))) {
      fail(`could not write ${spec.name} into ${platform.configPath}`);
    }
    step(`${spec.name} → ${platform.configLabel}`);
  }
  done(`Wrote ${platform.configPath} (chmod 600).`);
  console.log(
    `\nWriting ${platform.configPath} alone does not restart the ` +
      `${platform.serviceKind} — apply it with:\n` +
      "  bun run deploy",
  );
  // The two profiles write to different files, and the missing one is the
  // moment that confusion surfaces: --prod never touches .env.
  if (!(await Bun.file(".env").exists())) {
    warn("this did not create .env — for development run `bun run env:pull`.");
  }
} else {
  // Read-modify-write rather than regenerate: anything you added to .env by
  // hand has to survive a pull.
  const file = Bun.file(".env");
  const existing = (await file.exists()) ? await file.text() : "";
  let lines: readonly EnvLine[] = parseEnvFile(existing);

  for (const spec of ENV_MANIFEST) {
    const value = resolveSpec(spec, profile, home, secrets);
    if (value === null) {
      continue;
    }
    lines = upsertEntry(lines, spec, value);
    step(`${spec.name} → .env`);
  }

  await Bun.write(".env", serializeEnvFile(lines));
  await chmod(".env", 0o600);
  done("Wrote .env (chmod 600).");
  console.log("\nNext: bun run dev");
}
