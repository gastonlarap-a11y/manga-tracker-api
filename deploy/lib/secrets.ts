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
import type { PlatformAdapter } from "./platform";
import type { Runner } from "./run";

export type SecretOrigin = "config" | "cache" | "keyvault";

export interface ResolvedSecret {
  readonly value: string;
  readonly from: SecretOrigin;
}

export type SecretSpec = EnvSpec & { kind: "secret" };

export interface ResolveOptions {
  /** Skipped when the vault is unreachable or `az` is missing. */
  readonly vault: string;
  readonly platform: PlatformAdapter;
  /** Writes anything found further down the cascade back to the local cache. */
  readonly cache?: boolean;
  readonly onStep?: (message: string) => void;
}

export async function resolveSecret(
  run: Runner,
  spec: SecretSpec,
  { vault, platform, cache = true, onStep = () => {} }: ResolveOptions,
): Promise<ResolvedSecret | null> {
  const fromConfig = await platform.readConfigEnv(run, spec.name);
  if (fromConfig !== null) {
    onStep(`${spec.name}: found in the ${platform.configLabel}`);
    if (cache) {
      await platform.writeSecret(run, fromConfig);
    }
    return { value: fromConfig, from: "config" };
  }

  const fromCache = await platform.readSecret(run);
  if (fromCache !== null) {
    onStep(`${spec.name}: found in the ${platform.secretCacheLabel}`);
    return { value: fromCache, from: "cache" };
  }

  if (!(await isAzInstalled(run))) {
    const installHint =
      process.platform === "win32"
        ? "winget install -e --id Microsoft.AzureCLI"
        : "brew install azure-cli";
    onStep(
      `${spec.name}: not local, and the Azure CLI is missing — ` +
        `\`${installHint}\` then \`az login\``,
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
    await platform.writeSecret(run, fromVault);
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
