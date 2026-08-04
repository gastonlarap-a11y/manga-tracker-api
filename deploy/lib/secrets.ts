/**
 * Resolving a shared secret on whatever machine you happen to be on.
 *
 * The cascade goes cheapest-first — a configured plist costs nothing, the
 * Keychain is local and offline, Key Vault needs the network and a login — and
 * it is what makes `az login` the only thing a formatted Mac needs: your Azure
 * account is the root of trust, so there is no secret to store in order to
 * fetch the secret.
 */
import { getSecret, isAzInstalled, setSecret } from "./az";
import type { EnvSpec } from "./env";
import { readKeychain, readPlistEnv, writeKeychain } from "./macos";
import type { Runner } from "./run";

export type SecretOrigin = "plist" | "keychain" | "keyvault";

export interface ResolvedSecret {
  readonly value: string;
  readonly from: SecretOrigin;
}

export type SecretSpec = EnvSpec & { kind: "secret" };

export interface ResolveOptions {
  /** Skipped when the vault is unreachable or `az` is missing. */
  readonly vault: string;
  /** Writes anything found further down the cascade back to the Keychain. */
  readonly cache?: boolean;
  readonly onStep?: (message: string) => void;
}

export async function resolveSecret(
  run: Runner,
  spec: SecretSpec,
  { vault, cache = true, onStep = () => {} }: ResolveOptions,
): Promise<ResolvedSecret | null> {
  const fromPlist = await readPlistEnv(run, spec.name);
  if (fromPlist !== null) {
    onStep(`${spec.name}: found in the LaunchAgent plist`);
    if (cache) {
      await writeKeychain(run, fromPlist);
    }
    return { value: fromPlist, from: "plist" };
  }

  const fromKeychain = await readKeychain(run);
  if (fromKeychain !== null) {
    onStep(`${spec.name}: found in the Keychain`);
    return { value: fromKeychain, from: "keychain" };
  }

  if (!(await isAzInstalled(run))) {
    onStep(
      `${spec.name}: not local, and the Azure CLI is missing — ` +
        "`brew install azure-cli` then `az login`",
    );
    return null;
  }

  onStep(`${spec.name}: not local, asking Key Vault "${vault}"…`);
  const fromVault = await getSecret(run, vault, spec.secretName);
  if (fromVault === null) {
    return null;
  }
  onStep(`${spec.name}: recovered from Key Vault`);
  if (cache) {
    await writeKeychain(run, fromVault);
  }
  return { value: fromVault, from: "keyvault" };
}

export type PushOutcome = "created" | "updated" | "unchanged";

/**
 * Uploads only when the value actually differs, so re-running does not pile up
 * identical versions in the vault's history.
 */
export async function pushSecret(
  run: Runner,
  vault: string,
  spec: SecretSpec,
  value: string,
): Promise<PushOutcome> {
  const existing = await getSecret(run, vault, spec.secretName);
  if (existing === value) {
    return "unchanged";
  }
  await setSecret(run, vault, spec.secretName, value);
  return existing === null ? "created" : "updated";
}
