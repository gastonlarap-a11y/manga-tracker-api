/**
 * The backend's service control, as a process.
 *
 * The desktop app is written in Go and has to install and configure this
 * backend on someone else's computer. Everything needed to do that already
 * exists here — `deploy/lib/macos.ts` and `deploy/lib/windows.ts` — and it
 * carries knowledge that cost broken installs to get right: on macOS the
 * bootout → wait for the job to disappear → bootstrap sequence, on Windows the
 * S4U logon type plus the `icacls` grant afterwards. Reimplementing that in Go
 * would be reintroducing those bugs from scratch.
 *
 * So it is exposed as a command instead of duplicated: the app spawns this,
 * reads one JSON object from stdout, and checks the exit code. That is a border
 * a test can stand on, and it does not tie the two languages together.
 *
 * Usage (every command prints a single JSON object):
 *   service-cli install --app-dir <dir> --data-dir <dir> [--port <n>]
 *   service-cli status
 *   service-cli restart
 *   service-cli set-sync [--db <name>]      (connection string on stdin)
 *   service-cli use-stored-sync [--db <name>]
 *   service-cli clear-sync
 *   service-cli stop
 *
 * `set-sync` reads the connection string from **stdin**, never from a flag.
 * This repo already holds that rule for `az` — a secret on the command line is
 * readable by every process on the machine through `ps` — and the credential
 * the desktop app forwards is exactly the kind of thing that rule is for.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXTENSION_IDS } from "../src/lib/cors";
import { candidatePorts, parsePort } from "../src/lib/port";
import { type PlatformAdapter, platform } from "./lib/platform";
import { type Runner, spawnRunner } from "./lib/run";
import { KEYSTORE_SENTINEL } from "./lib/sync-secret";

/** Every reply is one JSON object, so the caller never has to guess. */
type Reply = Record<string, unknown>;

/**
 * Reads the credential the caller is passing in.
 *
 * A parameter for the same reason `Runner` and `PlatformAdapter` are: the suite
 * has to drive `set-sync` without a process behind it, and a test that had to
 * write to a real stdin would be testing Bun, not this.
 */
export type StdinReader = () => Promise<string>;

const defaultReadStdin: StdinReader = () => Bun.stdin.text();

export function parseArgs(argv: readonly string[]): {
  command: string;
  options: Map<string, string>;
} {
  const [command = "", ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === undefined || !flag.startsWith("--")) {
      continue;
    }
    const next = rest[index + 1];
    const hasValue = next !== undefined && !next.startsWith("--");
    // A flag followed by another flag is a flag, not a key whose value is the
    // next flag's name.
    options.set(flag.slice(2), hasValue ? next : "");
    if (hasValue) {
      index += 1;
    }
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
}

/**
 * Binding is the only honest way to ask whether a port is free: anything else
 * races with whatever takes it a millisecond later. The window comes from
 * `src/lib/port.ts` — the same one the extension and the desktop app probe.
 */
export async function firstFreePort(): Promise<number> {
  const ports = candidatePorts();
  for (const port of ports) {
    try {
      const probe = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response(),
      });
      probe.stop(true);
      return port;
    } catch {
      // Taken. Next one.
    }
  }
  throw new Error(
    `no free port between ${ports[0]} and ${ports.at(-1)}. ` +
      "The extension and the desktop app only look inside that window.",
  );
}

/**
 * The server part of a connection string, and nothing else.
 *
 * Written by hand rather than with `new URL()`: a MongoDB URI may carry a seed
 * list (`mongodb://a:1,b:2/`), which is legal there and not a URL at all, so the
 * parser throws on exactly the addresses a replica set produces.
 *
 * Everything before the last `@` is dropped, which is where the user and the
 * password live. This function must never be able to return them — it is what
 * the app puts on screen.
 */
export function hostOf(raw: string | null): string {
  if (raw === null || raw === "") {
    return "";
  }
  const withoutScheme = raw.replace(/^mongodb(\+srv)?:\/\//i, "");
  // The last one: a password may contain an encoded @, and splitting on the
  // first would hand back the tail of a credential as if it were a hostname.
  const afterCredentials = withoutScheme.slice(
    withoutScheme.lastIndexOf("@") + 1,
  );
  return afterCredentials.split(/[/?]/)[0] ?? "";
}

/** The four values an installed backend needs. Nothing personal is among them. */
export function environmentFor(
  appDir: string,
  dataDir: string,
  port: number,
): Map<string, string> {
  return new Map([
    ["DATABASE_URL", `file:${join(dataDir, "mangatracker.db")}`],
    ["PORT", String(port)],
    ["EXTENSION_IDS", DEFAULT_EXTENSION_IDS.join(",")],
    // The packaged server is a single bundled file with no src/ tree above it
    // to walk up from, so it is told where the .sql files live.
    ["MIGRATIONS_DIR", join(appDir, "migrations")],
  ]);
}

async function writeEnvironment(
  run: Runner,
  adapter: PlatformAdapter,
  values: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [key, value] of values) {
    if (!(await adapter.writeConfigEnv(run, key, value))) {
      throw new Error(`could not write ${key} to ${adapter.configLabel}`);
    }
  }
}

/**
 * `launch.js`, not `index.js`: the launcher reads the credential out of the
 * system keystore and puts it in the server's environment, so the service's own
 * configuration never has to hold it. See deploy/launcher.ts.
 */
const SERVICE_ENTRY = "launch.js";

async function install(
  run: Runner,
  adapter: PlatformAdapter,
  options: Map<string, string>,
): Promise<Reply> {
  const appDir = required(options, "app-dir");
  const dataDir = required(options, "data-dir");
  const port = options.has("port")
    ? parsePort(options.get("port"))
    : await firstFreePort();

  // The database lives here and the server does not create the directory.
  await mkdir(dataDir, { recursive: true });

  // The definition first, with no values in it: on macOS the environment is
  // written with `plutil -replace`, which fails on a plist that does not exist.
  const outcome = await adapter.installService(run, {
    bunPath: join(appDir, adapter.os === "win32" ? "bun.exe" : "bun"),
    entry: SERVICE_ENTRY,
    workingDirectory: appDir,
  });

  await writeEnvironment(run, adapter, environmentFor(appDir, dataDir, port));
  await adapter.reloadService(run);

  return {
    ok: true,
    port,
    dataDir,
    service: adapter.serviceLabel,
    serviceKind: adapter.serviceKind,
    // Reported rather than swallowed: on Windows a task registered from an
    // elevated shell can end up unstartable by the account that owns it.
    userCanControlIt: outcome.userCanControlIt,
  };
}

/**
 * Rewrites the service definition of a machine that already has one.
 *
 * `restart` only reloads; it never touches what is registered. So a machine
 * installed before the launcher existed would go on starting `index.js`
 * forever, and `set-sync` would hand it a configuration it cannot read. This is
 * what the app calls after an update, and it is the whole migration.
 *
 * The sync settings are read first and written back afterwards, because
 * registering the definition is what wipes them: `writePlist` creates the plist
 * with an empty environment on purpose, so that exactly one code path writes
 * values into it. Without this, updating would quietly switch sync off.
 */
async function repair(
  run: Runner,
  adapter: PlatformAdapter,
  options: Map<string, string>,
): Promise<Reply> {
  const appDir = required(options, "app-dir");
  const dataDir = required(options, "data-dir");

  const existingPort = await adapter.readConfigEnv(run, "PORT");
  const preserved = new Map<string, string>();
  for (const key of ["MONGODB_URL", "MONGODB_DB"]) {
    const value = await adapter.readConfigEnv(run, key);
    if (value !== null && value !== "") {
      preserved.set(key, value);
    }
  }

  // The port is kept as it was: the extension caches it, and the desktop app
  // has it open in a window right now.
  const port =
    existingPort !== null && existingPort !== ""
      ? parsePort(existingPort)
      : await firstFreePort();

  await adapter.installService(run, {
    bunPath: join(appDir, adapter.os === "win32" ? "bun.exe" : "bun"),
    entry: SERVICE_ENTRY,
    workingDirectory: appDir,
  });
  await writeEnvironment(run, adapter, environmentFor(appDir, dataDir, port));
  await writeEnvironment(run, adapter, preserved);
  await adapter.reloadService(run);

  return {
    ok: true,
    port,
    repaired: adapter.serviceLabel,
    syncConfigured: preserved.has("MONGODB_URL"),
  };
}

async function status(run: Runner, adapter: PlatformAdapter): Promise<Reply> {
  const installed = await adapter.configExists();
  const port = installed ? await adapter.readConfigEnv(run, "PORT") : null;
  const syncUrl = installed
    ? await adapter.readConfigEnv(run, "MONGODB_URL")
    : null;
  // A machine that synced before still holds the credential in its keystore
  // even when the configuration has none — which is exactly what happens after
  // a fresh install replaces the service definition. Reporting that it exists
  // is what lets the app offer to carry it over instead of silently turning
  // sync off.
  const stored = await adapter.readSecret(run);
  const syncDb = installed
    ? await adapter.readConfigEnv(run, "MONGODB_DB")
    : null;
  // The configuration says whether sync is on; the value itself may be the
  // sentinel, in which case the address to display is the keystore's.
  const secretInConfig =
    syncUrl !== null && syncUrl !== "" && syncUrl !== KEYSTORE_SENTINEL;
  const effective = syncUrl === KEYSTORE_SENTINEL ? stored : syncUrl;

  return {
    ok: true,
    installed,
    port: port === null || port === "" ? null : Number(port),
    // Whether it is configured, never the credential itself.
    syncConfigured: syncUrl !== null && syncUrl !== "",
    hasStoredCredential: stored !== null && stored !== "",
    // True while the credential is still sitting in the service's own
    // configuration in plaintext, which is what the launcher exists to end.
    secretInConfig,
    // Where it points, so the app can say what it is synchronising against
    // instead of showing an empty form to someone who is already connected.
    // Host and database only — the user and the password stay here.
    syncHost: hostOf(effective),
    syncDb: syncDb ?? "",
    configPath: adapter.configPath,
    service: adapter.serviceLabel,
  };
}

/**
 * Sync is opt-in and personal: these are the user's own credentials, kept in the
 * system keystore, and nothing about them ships with the app.
 */
async function setSync(
  run: Runner,
  adapter: PlatformAdapter,
  options: Map<string, string>,
  url: string,
): Promise<Reply> {
  if (url === "") {
    throw new Error("no connection string was provided on stdin");
  }
  const db = options.get("db") || "mangatracker";
  if (!(await adapter.writeSecret(run, url))) {
    throw new Error(
      `could not store the credential in the ${adapter.secretCacheLabel}`,
    );
  }
  // The sentinel, not the value: the credential goes to the keystore and the
  // configuration only records that sync is on and where to look. The launcher
  // reads it back at startup. If this machine's service cannot do that — a
  // Windows task running as S4U may not be able to unwrap a DPAPI blob — the
  // app notices that sync did not come up and calls `pin-config-secret`, which
  // puts the value back here.
  await writeEnvironment(
    run,
    adapter,
    new Map([
      ["MONGODB_URL", KEYSTORE_SENTINEL],
      ["MONGODB_DB", db],
    ]),
  );
  await adapter.reloadService(run);
  return { ok: true, syncConfigured: true, secretInConfig: false, db };
}

/**
 * Writes the credential into the service's configuration after all.
 *
 * The fallback for a machine whose service cannot read its own keystore at
 * startup. Nothing about that is knowable in advance — it depends on how the
 * session was created — so it is discovered the only honest way: try the
 * keystore, see whether sync comes up, and come back here if it did not.
 *
 * Plaintext in a file locked to this account, which is what every install did
 * until now. Worse than the keystore, and far better than a sync that does not
 * run.
 */
async function pinConfigSecret(
  run: Runner,
  adapter: PlatformAdapter,
): Promise<Reply> {
  const stored = await adapter.readSecret(run);
  if (stored === null || stored === "") {
    throw new Error(
      `no credential is stored in the ${adapter.secretCacheLabel} on this machine`,
    );
  }
  await writeEnvironment(run, adapter, new Map([["MONGODB_URL", stored]]));
  await adapter.reloadService(run);
  return { ok: true, syncConfigured: true, secretInConfig: true };
}

/**
 * Turns sync on with the credential this machine already had.
 *
 * The installer writes four values and none is personal, which is what keeps
 * the author's infrastructure out of anyone else's copy. The cost is that
 * installing over an existing setup switched sync off without saying so. This
 * is the way back: the credential never left the machine, and reusing it takes
 * an explicit command.
 */
async function useStoredSync(
  run: Runner,
  adapter: PlatformAdapter,
  options: Map<string, string>,
): Promise<Reply> {
  const stored = await adapter.readSecret(run);
  if (stored === null || stored === "") {
    throw new Error(
      `no credential is stored in the ${adapter.secretCacheLabel} on this machine`,
    );
  }
  const db = options.get("db") || "mangatracker";
  // The sentinel, for the same reason as set-sync: the value is already in the
  // keystore, and the configuration only has to say that sync is on.
  await writeEnvironment(
    run,
    adapter,
    new Map([
      ["MONGODB_URL", KEYSTORE_SENTINEL],
      ["MONGODB_DB", db],
    ]),
  );
  await adapter.reloadService(run);
  // The form matters and the caller cannot see the value: a mongodb+srv:// URL
  // works here and never connects on Windows. Flagged rather than refused —
  // refusing it would break a setup that works today.
  return {
    ok: true,
    syncConfigured: true,
    db,
    usesSrv: stored.startsWith("mongodb+srv://"),
  };
}

/** Blank rather than removed: readers treat an empty value as "not configured". */
async function clearSync(
  run: Runner,
  adapter: PlatformAdapter,
): Promise<Reply> {
  await writeEnvironment(run, adapter, new Map([["MONGODB_URL", ""]]));
  await adapter.reloadService(run);
  return { ok: true, syncConfigured: false };
}

/**
 * The adapter is a parameter, not a module-level constant read off
 * `process.platform`: the suite has to exercise the Windows path from a Mac and
 * the other way round, exactly like `Runner` pins the commands.
 */
export async function runCommand(
  run: Runner,
  argv: readonly string[],
  adapter: PlatformAdapter = platform,
  readStdin: StdinReader = defaultReadStdin,
): Promise<Reply> {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case "install":
      return await install(run, adapter, options);
    case "status":
      return await status(run, adapter);
    case "restart":
      await adapter.reloadService(run);
      return { ok: true, restarted: adapter.serviceLabel };
    case "set-sync":
      // Read lazily, inside the one case that needs it: every other command
      // would otherwise block waiting for a stdin nobody is going to write.
      return await setSync(run, adapter, options, (await readStdin()).trim());
    case "use-stored-sync":
      return await useStoredSync(run, adapter, options);
    case "pin-config-secret":
      return await pinConfigSecret(run, adapter);
    case "repair":
      return await repair(run, adapter, options);
    case "clear-sync":
      return await clearSync(run, adapter);
    case "stop":
      // Separate from `restart` because an update has to extract over files the
      // running service holds open — which fails outright on Windows.
      await adapter.stopService(run);
      return { ok: true, stopped: adapter.serviceLabel };
    default:
      throw new Error(
        `unknown command "${command}". Expected install, repair, status, ` +
          `restart, set-sync, use-stored-sync, pin-config-secret, clear-sync ` +
          `or stop.`,
      );
  }
}

// Only when run as a program: importing this from a test must not touch the
// machine or call process.exit.
if (import.meta.main) {
  try {
    console.log(
      JSON.stringify(await runCommand(spawnRunner, Bun.argv.slice(2))),
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    console.log(JSON.stringify({ ok: false, error }));
    process.exit(1);
  }
}
