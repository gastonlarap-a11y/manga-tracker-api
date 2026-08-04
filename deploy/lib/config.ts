/**
 * Where the Azure side of this project lives.
 *
 * Committed on purpose: none of it is a secret, and a machine that just cloned
 * the repo has to know which vault to ask before it can get anything else. The
 * subscription is deliberately absent — it comes from whatever `az login`
 * session is active, so the file cannot drift out of sync with reality.
 */
import { join } from "node:path";

export interface DeployConfig {
  readonly resourceGroup: string;
  readonly location: string;
  readonly vaultName: string;
}

export const CONFIG_PATH = join(import.meta.dir, "..", "azure.json");

/** Precedence: `--vault` argument, then `MANGATRACKER_VAULT`, then the file. */
export async function loadDeployConfig(
  vaultOverride?: string,
): Promise<DeployConfig> {
  const file = Bun.file(CONFIG_PATH);
  if (!(await file.exists())) {
    throw new Error(`missing ${CONFIG_PATH}`);
  }
  const config = (await file.json()) as DeployConfig;
  const vaultName =
    vaultOverride ?? Bun.env.MANGATRACKER_VAULT ?? config.vaultName;
  return { ...config, vaultName };
}

/** Reads `--flag value` out of argv. */
export function flagValue(
  args: readonly string[],
  flag: string,
): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
