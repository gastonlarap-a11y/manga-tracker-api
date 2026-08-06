/**
 * Uploads this machine's shared secrets to Key Vault, so another machine can
 * pull them back with nothing but `az login`.
 *
 * Only variables the manifest marks as `secret` travel: `DATABASE_URL` holds an
 * absolute path that would be wrong anywhere else, and the rest are derivable.
 *
 * Usage:
 *   bun run env:push            # read from .env
 *   bun run env:push --prod     # read from the LaunchAgent plist
 */
import { canListSecrets, currentAccount, isAzInstalled } from "./lib/az";
import { flagValue, loadDeployConfig } from "./lib/config";
import { envValues, parseEnvFile, secretSpecs } from "./lib/env";
import { platform } from "./lib/platform";
import { spawnRunner } from "./lib/run";
import { pushSecret } from "./lib/secrets";
import { done, fail, heading, installErrorHandler, step, warn } from "./lib/ui";

installErrorHandler();

const args = process.argv.slice(2);
const profile = args.includes("--prod") ? "prod" : "dev";
const run = spawnRunner;

const { vaultName } = await loadDeployConfig(flagValue(args, "--vault"));

heading(`Pushing secrets to Key Vault "${vaultName}" (source: ${profile})`);

if (!(await isAzInstalled(run))) {
  const installHint =
    process.platform === "win32"
      ? "winget install -e --id Microsoft.AzureCLI"
      : "brew install azure-cli";
  fail("the Azure CLI is not installed", `  ${installHint}\n  az login`);
}
if ((await currentAccount(run)) === null) {
  fail("not logged in to Azure", "  az login");
}
if (!(await canListSecrets(run, vaultName))) {
  fail(
    `cannot read the vault "${vaultName}"`,
    "Either it does not exist yet or your role has not propagated:\n" +
      "  bun run deploy:provision",
  );
}

/** Where a secret's current value lives on this machine. */
async function localValue(name: string): Promise<string | null> {
  if (profile === "prod") {
    return await platform.readConfigEnv(run, name);
  }
  const envFile = Bun.file(".env");
  if (await envFile.exists()) {
    const fromFile = envValues(parseEnvFile(await envFile.text())).get(name);
    if (fromFile !== undefined && fromFile !== "") {
      return fromFile;
    }
  }
  return null;
}

let pushed = 0;
let missing = 0;

for (const spec of secretSpecs()) {
  const fromProfile = await localValue(spec.name);
  const value = fromProfile ?? (await platform.readSecret(run));
  if (value === null || value === "") {
    warn(
      `${spec.name}: nothing to push — not in ${profile} nor in the ` +
        `${platform.secretCacheLabel}.`,
    );
    missing++;
    continue;
  }
  if (fromProfile === null) {
    step(
      `${spec.name}: not in ${profile}, using the ${platform.secretCacheLabel} copy.`,
    );
  }

  // Values are never printed: this output goes into terminal scrollback.
  const outcome = await pushSecret(run, vaultName, spec, value);
  step(`${spec.name} → ${spec.secretName}: ${outcome}`);
  if (outcome !== "unchanged") {
    pushed++;
  }
  await platform.writeSecret(run, value);
}

if (missing > 0 && pushed === 0) {
  fail(
    "nothing was uploaded",
    profile === "prod"
      ? `Set the value in the ${platform.configLabel} first, or run \`bun run env:push\` to read .env.`
      : "Put MONGODB_URL in .env first (Azure portal → your cluster → Connection strings).",
  );
}

done(`Done. Another machine can now run: bun run env:pull`);
