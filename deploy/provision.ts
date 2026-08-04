/**
 * Creates the Azure Key Vault this project recovers its credentials from, and
 * grants the signed-in user access to it.
 *
 * Idempotent: run it twice and the second run does nothing. Safe to re-run
 * after a failure, which matters because RBAC propagation can outlast the
 * script's own patience.
 *
 * Usage:
 *   bun run deploy:provision
 *   bun run deploy:provision --vault my-kv   # different vault name
 *   bun run deploy:provision --recover       # bring back a soft-deleted vault
 */
import {
  assignSecretsOfficer,
  canListSecrets,
  createResourceGroup,
  createVault,
  currentAccount,
  isAzInstalled,
  isVaultNameAvailable,
  isVaultSoftDeleted,
  providerState,
  recoverVault,
  registerProvider,
  resourceGroupExists,
  signedInUserObjectId,
  vaultId,
} from "./lib/az";
import { flagValue, loadDeployConfig } from "./lib/config";
import { spawnRunner } from "./lib/run";
import { done, fail, heading, installErrorHandler, step, warn } from "./lib/ui";

installErrorHandler();

const args = process.argv.slice(2);
const wantsRecover = args.includes("--recover");
const run = spawnRunner;

const config = await loadDeployConfig(flagValue(args, "--vault"));
const { vaultName, resourceGroup, location } = config;

heading(`Provisioning Key Vault "${vaultName}"`);

if (!(await isAzInstalled(run))) {
  fail(
    "the Azure CLI is not installed",
    "  brew install azure-cli\n  az login",
  );
}

const account = await currentAccount(run);
if (account === null) {
  fail("not logged in to Azure", "  az login");
}
step(`Subscription: ${account.subscriptionName} (${account.user})`);

// --- resource provider ------------------------------------------------------

// A subscription that has never held a Key Vault rejects every create with
// MissingSubscriptionRegistration. Registering is idempotent and one-time.
const state = await providerState(run, "Microsoft.KeyVault");
if (state === "Registered") {
  step("Microsoft.KeyVault is registered on this subscription.");
} else {
  step(`Microsoft.KeyVault is ${state}; registering (this takes a minute)…`);
  await registerProvider(run, "Microsoft.KeyVault");
  done("Registered Microsoft.KeyVault.");
}

// --- resource group ---------------------------------------------------------

if (await resourceGroupExists(run, resourceGroup)) {
  step(`Resource group "${resourceGroup}" already exists.`);
} else {
  await createResourceGroup(run, resourceGroup, location);
  done(`Created resource group "${resourceGroup}" in ${location}.`);
}

// --- the vault --------------------------------------------------------------

let scope = await vaultId(run, vaultName);

if (scope !== null) {
  step(`Vault "${vaultName}" already exists.`);
} else if (await isVaultSoftDeleted(run, vaultName)) {
  // Soft delete is mandatory on Key Vault: the name stays reserved until the
  // retention window ends or someone purges it.
  if (!wantsRecover) {
    fail(
      `vault "${vaultName}" exists in a soft-deleted state, so the name is taken`,
      `Recover it (keeps the old secrets):\n` +
        `  bun run deploy:provision --recover\n\n` +
        `Or destroy it for good and start clean:\n` +
        `  az keyvault purge --name ${vaultName}`,
    );
  }
  await recoverVault(run, vaultName, location);
  scope = await vaultId(run, vaultName);
  done(`Recovered the soft-deleted vault "${vaultName}".`);
} else {
  if (!(await isVaultNameAvailable(run, vaultName))) {
    fail(
      `the name "${vaultName}" is taken by someone else's vault`,
      "Vault names are global DNS labels under vault.azure.net. Pick another:\n" +
        "  bun run deploy:provision --vault kv-mangatracker-<algo>\n" +
        "…then put the same name in deploy/azure.json.",
    );
  }
  scope = await createVault(run, { vault: vaultName, resourceGroup, location });
  done(`Created the vault (RBAC authorization, 7-day soft-delete retention).`);
}

if (scope === null) {
  fail(`the vault "${vaultName}" is not readable after provisioning`);
}

// --- data-plane access ------------------------------------------------------

// Creating a vault grants control-plane rights only. Without this assignment
// the very next `secret set` returns 403, which is the single most common way
// this setup appears "broken" right after it was created.
const objectId = await signedInUserObjectId(run);
const { created } = await assignSecretsOfficer(run, scope, objectId);
step(
  created
    ? "Granted Key Vault Secrets Officer to you."
    : "You already hold Key Vault Secrets Officer.",
);

// --- wait for RBAC to propagate ---------------------------------------------

step("Waiting for the role assignment to take effect…");
const deadline = Date.now() + 5 * 60_000;
let ready = false;
while (Date.now() < deadline) {
  if (await canListSecrets(run, vaultName)) {
    ready = true;
    break;
  }
  await Bun.sleep(5_000);
}

if (!ready) {
  warn(
    "the role has not propagated yet (it can take several minutes).\n" +
      "  Nothing is broken — re-run this command, or just try `bun run env:push`.",
  );
  process.exit(0);
}

done("The vault is ready.");
console.log(
  `\nNext: bun run env:push   # upload MONGODB_URL to "${vaultName}"`,
);
