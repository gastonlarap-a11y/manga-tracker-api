/**
 * Puts the sync credential back on a machine that does not have it — after a
 * format, or on a second Mac — without anyone retyping a connection string.
 *
 * It resolves in cascade, cheapest first:
 *   1. the LaunchAgent plist (already configured, nothing to do)
 *   2. the macOS Keychain (local, offline, survives reinstalling the app)
 *   3. Azure Key Vault via `az` (survives wiping the disk — your Azure account
 *      is the root of trust, so there is no secret to store to get the secret)
 *
 * Whatever it finds is written back to the plist and cached in the Keychain, so
 * this is a once-per-machine command rather than something the app calls.
 *
 * Usage:
 *   bun run sync:bootstrap                 # resolve and install
 *   bun run sync:bootstrap --store         # upload the current credential to Key Vault
 *   bun run sync:bootstrap --vault my-kv   # override the vault name
 */
import { homedir } from "node:os";
import { join } from "node:path";

const PLIST = join(homedir(), "Library/LaunchAgents/com.mangatracker.plist");
const KEYCHAIN_SERVICE = "manga-tracker-mongodb";
const SECRET_NAME = "mangatracker-mongodb-url";
const DEFAULT_VAULT = Bun.env.MANGATRACKER_VAULT ?? "kv-mangatracker";

const args = process.argv.slice(2);
const wantsStore = args.includes("--store");
const vaultIndex = args.indexOf("--vault");
const vault =
  vaultIndex >= 0 ? (args[vaultIndex + 1] ?? DEFAULT_VAULT) : DEFAULT_VAULT;

async function run(
  cmd: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    ok: (await proc.exited) === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function fromPlist(): Promise<string | null> {
  const result = await run([
    "plutil",
    "-extract",
    "EnvironmentVariables.MONGODB_URL",
    "raw",
    "-o",
    "-",
    PLIST,
  ]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

async function fromKeychain(): Promise<string | null> {
  const result = await run([
    "security",
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

async function fromKeyVault(): Promise<string | null> {
  if ((await run(["which", "az"])).ok === false) {
    console.error(
      "  Azure CLI not installed. `brew install azure-cli`, then `az login`.",
    );
    return null;
  }
  const result = await run([
    "az",
    "keyvault",
    "secret",
    "show",
    "--vault-name",
    vault,
    "--name",
    SECRET_NAME,
    "--query",
    "value",
    "-o",
    "tsv",
  ]);
  if (!result.ok) {
    // Most often: not logged in, or the vault does not exist yet.
    console.error(`  Key Vault read failed: ${result.stderr.split("\n")[0]}`);
    return null;
  }
  return result.stdout === "" ? null : result.stdout;
}

async function toKeychain(value: string): Promise<boolean> {
  // -U updates in place when the item already exists.
  const result = await run([
    "security",
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_SERVICE,
    "-w",
    value,
  ]);
  return result.ok;
}

async function toPlist(value: string): Promise<boolean> {
  const result = await run([
    "plutil",
    "-replace",
    "EnvironmentVariables.MONGODB_URL",
    "-string",
    value,
    PLIST,
  ]);
  if (result.ok) {
    // The plist now holds a password; default permissions are world-readable.
    await run(["chmod", "600", PLIST]);
  }
  return result.ok;
}

async function toKeyVault(value: string): Promise<boolean> {
  const result = await run([
    "az",
    "keyvault",
    "secret",
    "set",
    "--vault-name",
    vault,
    "--name",
    SECRET_NAME,
    "--value",
    value,
    "-o",
    "none",
  ]);
  if (!result.ok) {
    console.error(result.stderr.split("\n").slice(0, 3).join("\n"));
  }
  return result.ok;
}

// --store: push what this machine already has up to Key Vault, so another one
// can get it back later.
if (wantsStore) {
  const existing = (await fromPlist()) ?? (await fromKeychain());
  if (existing === null) {
    console.error("Nothing to store: no credential in the plist or Keychain.");
    process.exit(1);
  }
  console.log(`Storing the connection string in Key Vault "${vault}"…`);
  if (!(await toKeyVault(existing))) {
    console.error("Failed. Is `az login` done and the vault created?");
    process.exit(1);
  }
  await toKeychain(existing);
  console.log("Stored. Another machine can now run `bun run sync:bootstrap`.");
  process.exit(0);
}

console.log("Looking for the sync credential…");

const inPlist = await fromPlist();
if (inPlist !== null) {
  console.log("• Already configured in the LaunchAgent plist.");
  // Still worth caching: the Keychain is what survives replacing the plist.
  await toKeychain(inPlist);
  console.log("• Cached in the Keychain for next time.");
  process.exit(0);
}

console.log("• Not in the plist.");
let credential = await fromKeychain();
if (credential !== null) {
  console.log("• Found in the Keychain.");
} else {
  console.log("• Not in the Keychain. Trying Azure Key Vault…");
  credential = await fromKeyVault();
  if (credential === null) {
    console.error(
      "\nCould not recover the credential. Either run `az login` and retry, or\n" +
        "paste the connection string into the plist by hand (Azure portal →\n" +
        "your cluster → Connection strings).",
    );
    process.exit(1);
  }
  console.log("• Recovered from Key Vault.");
  await toKeychain(credential);
}

if (!(await toPlist(credential))) {
  console.error(
    `Could not write ${PLIST}. Does the LaunchAgent exist on this machine?`,
  );
  process.exit(1);
}

console.log("• Written to the plist (chmod 600).");
console.log(
  "\nDone. Reload the service to pick it up:\n" +
    "  launchctl bootout gui/$(id -u)/com.mangatracker\n" +
    "  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mangatracker.plist",
);
