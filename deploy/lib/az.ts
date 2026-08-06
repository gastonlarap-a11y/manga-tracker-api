/** Azure CLI operations. Every one goes through a `Runner` so they are testable. */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, Runner } from "./run";

/**
 * Key Vault Secrets Officer. Microsoft's own guidance is to reference roles by
 * ID in scripts, because a role rename would silently break the name form.
 */
export const SECRETS_OFFICER_ROLE_ID = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7";

export interface Account {
  readonly subscriptionId: string;
  readonly subscriptionName: string;
  readonly user: string;
}

export class AzError extends Error {
  constructor(
    message: string,
    readonly result: CommandResult,
  ) {
    // az prints a multi-line traceback for some failures; the first line is
    // the part a human needs.
    super(`${message}: ${result.stderr.split("\n")[0] ?? result.stdout}`);
    this.name = "AzError";
  }
}

const json = <T>(result: CommandResult): T => JSON.parse(result.stdout) as T;

/**
 * `which` does not exist on Windows (no `cmd.exe`/PowerShell built-in), so the
 * probe itself has to pick the right command instead of hoping one binary
 * name works everywhere.
 */
export async function isAzInstalled(
  run: Runner,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await run([platform === "win32" ? "where" : "which", "az"])).ok;
}

/** Null when `az login` has not been run (or the token expired). */
export async function currentAccount(run: Runner): Promise<Account | null> {
  const result = await run([
    "az",
    "account",
    "show",
    "--query",
    "{subscriptionId:id,subscriptionName:name,user:user.name}",
    "-o",
    "json",
  ]);
  return result.ok ? json<Account>(result) : null;
}

/** Entra object id of the signed-in user — the assignee for role assignments. */
export async function signedInUserObjectId(run: Runner): Promise<string> {
  const result = await run([
    "az",
    "ad",
    "signed-in-user",
    "show",
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  if (!result.ok) {
    throw new AzError("could not read the signed-in user", result);
  }
  return result.stdout;
}

/**
 * A subscription that has never held a given resource type has that provider
 * unregistered, and every create fails with MissingSubscriptionRegistration.
 * It is a one-time step per subscription, which is exactly the kind of thing
 * an automated setup should absorb rather than report.
 */
export async function providerState(
  run: Runner,
  namespace: string,
): Promise<string> {
  const result = await run([
    "az",
    "provider",
    "show",
    "--namespace",
    namespace,
    "--query",
    "registrationState",
    "-o",
    "tsv",
  ]);
  return result.ok ? result.stdout : "Unknown";
}

/** Blocks until the provider finishes registering; can take a couple of minutes. */
export async function registerProvider(
  run: Runner,
  namespace: string,
): Promise<void> {
  const result = await run([
    "az",
    "provider",
    "register",
    "--namespace",
    namespace,
    "--wait",
  ]);
  if (!result.ok) {
    throw new AzError(`could not register ${namespace}`, result);
  }
}

export async function resourceGroupExists(
  run: Runner,
  name: string,
): Promise<boolean> {
  return (await run(["az", "group", "show", "--name", name, "-o", "none"])).ok;
}

export async function createResourceGroup(
  run: Runner,
  name: string,
  location: string,
): Promise<void> {
  const result = await run([
    "az",
    "group",
    "create",
    "--name",
    name,
    "--location",
    location,
    "-o",
    "none",
  ]);
  if (!result.ok) {
    throw new AzError(`could not create the resource group ${name}`, result);
  }
}

/** The vault's ARM id, or null when it does not exist in this subscription. */
export async function vaultId(
  run: Runner,
  vault: string,
): Promise<string | null> {
  const result = await run([
    "az",
    "keyvault",
    "show",
    "--name",
    vault,
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  return result.ok ? result.stdout : null;
}

/**
 * Vault names are DNS labels under `vault.azure.net`, so they are unique across
 * all of Azure — someone else's vault can take the name we want.
 */
export async function isVaultNameAvailable(
  run: Runner,
  vault: string,
): Promise<boolean> {
  const result = await run([
    "az",
    "keyvault",
    "check-name",
    "--name",
    vault,
    "--query",
    "nameAvailable",
    "-o",
    "tsv",
  ]);
  if (!result.ok) {
    throw new AzError(`could not check the name ${vault}`, result);
  }
  return result.stdout === "true";
}

/** Soft-delete is mandatory: a deleted vault blocks its own name until purged. */
export async function isVaultSoftDeleted(
  run: Runner,
  vault: string,
): Promise<boolean> {
  const result = await run([
    "az",
    "keyvault",
    "list-deleted",
    "--query",
    `[?name=='${vault}'] | length(@)`,
    "-o",
    "tsv",
  ]);
  return result.ok && result.stdout !== "0" && result.stdout !== "";
}

export async function recoverVault(
  run: Runner,
  vault: string,
  location: string,
): Promise<void> {
  const result = await run([
    "az",
    "keyvault",
    "recover",
    "--name",
    vault,
    "--location",
    location,
    "-o",
    "none",
  ]);
  if (!result.ok) {
    throw new AzError(`could not recover the vault ${vault}`, result);
  }
}

export interface CreateVaultOptions {
  readonly vault: string;
  readonly resourceGroup: string;
  readonly location: string;
}

/**
 * RBAC is passed explicitly even though it is the default since API version
 * 2026-02-01, so reading this file tells you the authorization model without
 * knowing which CLI version ran it.
 *
 * Purge protection is deliberately NOT enabled: it is irreversible and would
 * make a mistake in a personal project unfixable for 90 days. `--retention-days
 * 7` is the minimum the service accepts, so a purge-and-retry costs a week at
 * worst instead of three months.
 */
export async function createVault(
  run: Runner,
  { vault, resourceGroup, location }: CreateVaultOptions,
): Promise<string> {
  const result = await run([
    "az",
    "keyvault",
    "create",
    "--name",
    vault,
    "--resource-group",
    resourceGroup,
    "--location",
    location,
    "--enable-rbac-authorization",
    "true",
    "--retention-days",
    "7",
    "--query",
    "id",
    "-o",
    "tsv",
  ]);
  if (!result.ok) {
    throw new AzError(`could not create the vault ${vault}`, result);
  }
  return result.stdout;
}

/**
 * Creating a vault grants NO data-plane access under RBAC, so without this the
 * very next `secret set` fails with 403. Re-running is a no-op: Azure reports
 * an existing assignment as a conflict, which we treat as success.
 */
export async function assignSecretsOfficer(
  run: Runner,
  scope: string,
  objectId: string,
): Promise<{ readonly created: boolean }> {
  const result = await run([
    "az",
    "role",
    "assignment",
    "create",
    "--role",
    SECRETS_OFFICER_ROLE_ID,
    "--assignee-object-id",
    objectId,
    // Skips the Graph lookup, which misresolves for accounts that are guests in
    // their own tenant (the UPN comes back in `user_outlook.cl#EXT#@…` form).
    "--assignee-principal-type",
    "User",
    "--scope",
    scope,
    "-o",
    "none",
  ]);
  if (result.ok) {
    return { created: true };
  }
  if (/already exists|RoleAssignmentExists/i.test(result.stderr)) {
    return { created: false };
  }
  throw new AzError("could not assign Key Vault Secrets Officer", result);
}

/** Whether the data plane answers yet — RBAC takes minutes to propagate. */
export async function canListSecrets(
  run: Runner,
  vault: string,
): Promise<boolean> {
  return (
    await run([
      "az",
      "keyvault",
      "secret",
      "list",
      "--vault-name",
      vault,
      "-o",
      "none",
    ])
  ).ok;
}

export async function listSecretNames(
  run: Runner,
  vault: string,
): Promise<string[]> {
  const result = await run([
    "az",
    "keyvault",
    "secret",
    "list",
    "--vault-name",
    vault,
    "--query",
    "[].name",
    "-o",
    "json",
  ]);
  if (!result.ok) {
    throw new AzError(`could not list secrets in ${vault}`, result);
  }
  return json<string[]>(result);
}

/** Null when the secret does not exist; throws on any other failure. */
export async function getSecret(
  run: Runner,
  vault: string,
  name: string,
): Promise<string | null> {
  const result = await run([
    "az",
    "keyvault",
    "secret",
    "show",
    "--vault-name",
    vault,
    "--name",
    name,
    "--query",
    "value",
    // json rather than tsv: tsv mangles a value containing tabs or newlines.
    "-o",
    "json",
  ]);
  if (result.ok) {
    return json<string>(result);
  }
  if (/SecretNotFound|was not found in this key vault/i.test(result.stderr)) {
    return null;
  }
  throw new AzError(`could not read the secret ${name}`, result);
}

/**
 * Written through a 0600 temp file rather than `--value`, because arguments are
 * visible to every process on the machine via `ps`. The file is removed even if
 * az fails.
 */
export async function setSecret(
  run: Runner,
  vault: string,
  name: string,
  value: string,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mangatracker-secret-"));
  const file = join(dir, "value");
  try {
    await Bun.write(file, value);
    await chmod(file, 0o600);
    const result = await run([
      "az",
      "keyvault",
      "secret",
      "set",
      "--vault-name",
      vault,
      "--name",
      name,
      "--file",
      file,
      "--encoding",
      "utf-8",
      "-o",
      "none",
    ]);
    if (!result.ok) {
      throw new AzError(`could not write the secret ${name}`, result);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
