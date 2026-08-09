/**
 * Everything that is specific to this Windows machine: the scheduled task,
 * its `prod.env`, and a DPAPI-encrypted secret cache. Kept apart from `az.ts`
 * because none of it has a cloud equivalent — this is the machine, not the
 * account. Mirrors `macos.ts` function for function; `platform.ts` wires both
 * into the shape the deploy scripts share.
 *
 * There is no Windows Service here on purpose: `sc.exe` requires the target
 * binary to implement the SCM's start/stop control protocol
 * (`StartServiceCtrlDispatcher`), which `bun.exe` does not — a service
 * pointed at it fails at start with Error 1053. Task Scheduler has no such
 * requirement; it supervises a PID like any process launcher, which is a
 * closer match to what a LaunchAgent does anyway.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { type EnvLine, parseEnvFile, serializeEnvFile } from "./env";
import type { Runner } from "./run";

export const TASK_NAME = "MangaTracker";
export const CONFIG_DIR = join(homedir(), "AppData", "Local", "MangaTracker");
export const CONFIG_PATH = join(CONFIG_DIR, "prod.env");
export const SECRET_DIR = join(CONFIG_DIR, "secrets");
export const SECRET_PATH = join(SECRET_DIR, "mongodb-url.dpapi");
export const LOG_DIR = join(CONFIG_DIR, "logs");
export const OUT_LOG_PATH = join(LOG_DIR, "out.log");
export const LOG_PATH = join(LOG_DIR, "err.log");

// ---------------------------------------------------------------------------
// prod.env — the plist's equivalent: where production's resolved values live
// ---------------------------------------------------------------------------

export async function configExists(path = CONFIG_PATH): Promise<boolean> {
  return await Bun.file(path).exists();
}

export async function readConfigEnv(
  _run: Runner,
  key: string,
  path = CONFIG_PATH,
): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return null;
  }
  const entry = parseEnvFile(await file.text()).find(
    (line): line is EnvLine & { kind: "entry" } =>
      line.kind === "entry" && line.key === key,
  );
  return entry?.value ?? null;
}

/** Replaces the entry in place, or appends it — no comment, unlike the dev .env. */
function upsertRaw(
  lines: readonly EnvLine[],
  key: string,
  value: string,
): EnvLine[] {
  const index = lines.findIndex(
    (line) => line.kind === "entry" && line.key === key,
  );
  const entry: EnvLine = { kind: "entry", key, value };
  return index >= 0 ? lines.with(index, entry) : [...lines, entry];
}

/**
 * Tightens permissions with `icacls` after every write, the same reason
 * `macos.ts` chmods the plist: this file holds the cluster password in
 * plaintext. `fs.chmod` on Windows only toggles the read-only bit, not real
 * ACLs, so the restriction has to go through a real Windows tool.
 */
export async function writeConfigEnv(
  run: Runner,
  key: string,
  value: string,
  path = CONFIG_PATH,
): Promise<boolean> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await Bun.write(
    path,
    serializeEnvFile(upsertRaw(parseEnvFile(existing), key, value)),
  );
  const result = await run([
    "icacls",
    path,
    "/inheritance:r",
    "/grant:r",
    `${userInfo().username}:F`,
  ]);
  return result.ok;
}

// ---------------------------------------------------------------------------
// DPAPI secret cache — the Keychain's equivalent
// ---------------------------------------------------------------------------

/**
 * Reads back through PowerShell's own DPAPI unwrap. The value never touches
 * argv — only a path does — so it cannot leak through `ps`/Task Manager.
 * `Microsoft.PowerShell.Security` ships with every Windows install, so this
 * needs nothing installed, unlike the `CredentialManager` module.
 */
export async function readSecret(
  run: Runner,
  // Overridable for the same reason `readConfigEnv` takes its path: a test that
  // reads the real cache passes or fails depending on whether this machine
  // happens to have been bootstrapped.
  path = SECRET_PATH,
): Promise<string | null> {
  if (!(await Bun.file(path).exists())) {
    return null;
  }
  const result = await run([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$enc = Get-Content -Raw -Path '${path}'; ` +
      `$secure = ConvertTo-SecureString -String $enc; ` +
      "$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); " +
      "[Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)",
  ]);
  return result.ok && result.stdout !== "" ? result.stdout : null;
}

/**
 * DPAPI ties the ciphertext to this user and this machine — the same threat
 * model as the macOS Keychain. The plaintext goes through a temp file rather
 * than argv, same reasoning as `az.ts`'s `setSecret`.
 */
export async function writeSecret(
  run: Runner,
  value: string,
): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "mangatracker-secret-"));
  const file = join(dir, "value");
  try {
    await Bun.write(file, value);
    const result = await run([
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$plain = Get-Content -Raw -Path '${file}'; ` +
        `$secure = ConvertTo-SecureString -String $plain -AsPlainText -Force; ` +
        `New-Item -ItemType Directory -Force -Path '${SECRET_DIR}' | Out-Null; ` +
        `ConvertFrom-SecureString -SecureString $secure | Set-Content -NoNewline -Path '${SECRET_PATH}'`,
    ]);
    return result.ok;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Task Scheduler — launchd's equivalent
// ---------------------------------------------------------------------------

/**
 * Whether this process is running elevated. `installTask` registers an S4U
 * task, which Windows refuses to create without administrator rights, and
 * discovering that only once the bootstrap has already provisioned a Key Vault
 * over the network is a bad way to find out.
 *
 * The check goes through PowerShell rather than probing a privileged command,
 * because it answers the literal `True`/`False` regardless of the system
 * language — the localized "Acceso denegado" from `schtasks` is exactly the
 * kind of string this must not depend on.
 */
export async function isElevated(run: Runner): Promise<boolean> {
  const result = await run([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Security.Principal.WindowsPrincipal]::new(" +
      "[Security.Principal.WindowsIdentity]::GetCurrent()" +
      ").IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
  ]);
  return result.ok && result.stdout.trim() === "True";
}

async function isRunning(run: Runner, name: string): Promise<boolean> {
  const result = await run([
    "schtasks",
    "/Query",
    "/TN",
    name,
    "/FO",
    "LIST",
    "/V",
  ]);
  return result.ok && /Status:\s*Running/i.test(result.stdout);
}

export interface ReloadOptions {
  readonly name?: string;
  /** How long to wait for the previous run to actually stop. */
  readonly settleAttempts?: number;
  readonly settleDelayMs?: number;
  readonly runAttempts?: number;
}

/**
 * A full stop/run, mirroring `macos.ts`'s bootout+bootstrap: `/End` followed
 * by `/Run` always makes `bun --env-file=` reread `prod.env`. Unlike
 * `kickstart -k` on macOS, there is no shortcut on this side that quietly
 * keeps a stale credential — Task Scheduler has nothing analogous to launchd's
 * in-memory cache to worry about.
 */
export async function reloadService(
  run: Runner,
  {
    name = TASK_NAME,
    settleAttempts = 20,
    settleDelayMs = 250,
    runAttempts = 3,
  }: ReloadOptions = {},
): Promise<void> {
  // /End fails when the task is not running, which is a fine starting state.
  await run(["schtasks", "/End", "/TN", name]);

  for (let attempt = 0; attempt < settleAttempts; attempt++) {
    if (!(await isRunning(run, name))) {
      break;
    }
    await Bun.sleep(settleDelayMs);
  }

  let last = await run(["schtasks", "/Run", "/TN", name]);
  for (let attempt = 1; attempt < runAttempts && !last.ok; attempt++) {
    await Bun.sleep(settleDelayMs * 2);
    last = await run(["schtasks", "/Run", "/TN", name]);
  }

  if (!last.ok) {
    throw new Error(
      `schtasks /Run failed after ${runAttempts} attempts: ` +
        `${last.stderr || last.stdout}\n` +
        `The service is now DOWN. Bring it back with:\n` +
        `  schtasks /Run /TN ${name}`,
    );
  }
}

export interface InstallTaskOptions {
  readonly name?: string;
  readonly bunPath: string;
  readonly workingDirectory: string;
  /**
   * What bun runs, relative to `workingDirectory`. A checkout runs the source;
   * an installed copy runs a single bundled file and has no `src/` at all.
   */
  readonly entry?: string;
}

export interface InstallTaskOutcome {
  /**
   * False when the task registered but the permission grant did not take. The
   * install is still usable — it just means the next `bun run deploy` may need
   * an elevated terminal, which the caller reports rather than swallows.
   */
  readonly userCanControlIt: boolean;
}

/** Where Task Scheduler keeps a task's definition, and its permissions. */
const taskFilePath = (name: string): string =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", "Tasks", name);

/**
 * Registers the scheduled task, the one-time step a LaunchAgent gets by
 * copying its plist by hand. `/F` makes this idempotent: re-running the
 * bootstrap overwrites rather than fails on an already-registered task.
 *
 * Two settings here each cost a broken install to get right, so both reasons are
 * written down:
 *
 * `LogonType` is `S4U`, NOT `InteractiveToken`. S4U runs the task in session 0,
 * where it has no console at all. `InteractiveToken` runs it in the user's
 * session, and the `cmd.exe` wrapper below then opens a visible console window
 * on the desktop — closing that stray window kills the backend, which is what
 * `LastTaskResult 0xC000013A` (STATUS_CONTROL_C_EXIT) plus a trailing `^C` in
 * err.log means when you see it. S4U also keeps running while logged off.
 *
 * The `icacls` grant afterwards is the other half of that choice. Registering
 * S4U requires elevation, and a task created from an elevated shell is owned by
 * `BUILTIN\Administrators` with the invoking user granted read only — which
 * locks the account the task runs as out of the `/Run` and `/End` in
 * `reloadService`, and therefore out of every `bun run deploy`. Task Scheduler
 * keeps a task's permissions in the ACL of its file under `System32\Tasks`, so
 * granting the user read+execute there is what makes the deploy work unelevated.
 *
 * It is done with `icacls` rather than the `<SecurityDescriptor>` element the
 * task XML schema defines, because `schtasks /Create /XML` silently ignores
 * that element — verified on Windows 11: the registered task came back with an
 * inherited `D:AI(...)` DACL instead of the `D:P` the XML asked for.
 *
 * `ExecutionTimeLimit` is `PT0S` (unlimited) on purpose — Task Scheduler's
 * default kills a task after 72 hours, which a backend meant to run
 * indefinitely cannot have.
 */
export async function installTask(
  run: Runner,
  {
    name = TASK_NAME,
    bunPath,
    workingDirectory,
    entry = "src\\index.ts",
  }: InstallTaskOptions,
): Promise<InstallTaskOutcome> {
  const user = `${process.env.COMPUTERNAME ?? ""}\\${userInfo().username}`;
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Manga Tracker backend (Bun + Hono), started at logon and kept alive.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c ""${bunPath}" --env-file="${CONFIG_PATH}" run "${entry}" >> "${OUT_LOG_PATH}" 2>> "${LOG_PATH}""</Arguments>
      <WorkingDirectory>${workingDirectory}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

  const dir = await mkdtemp(join(tmpdir(), "mangatracker-task-"));
  const file = join(dir, "task.xml");
  try {
    await Bun.write(file, xml);
    const result = await run([
      "schtasks",
      "/Create",
      "/XML",
      file,
      "/TN",
      name,
      "/F",
    ]);
    if (!result.ok) {
      // The remedy is unconditional rather than gated on matching the error
      // text: Windows localizes it (this one answers "Acceso denegado"), so a
      // regex over "access is denied" would miss the exact machine that needs
      // the hint. A denied /Create almost always means a task left over from an
      // earlier elevated run, which belongs to Administrators and cannot be
      // overwritten by the user it runs as.
      throw new Error(
        `schtasks /Create failed: ${result.stderr || result.stdout}\n` +
          `If this is a permissions error, a task named ${name} from an older ` +
          `install is in the way and belongs to another account. Remove it once ` +
          `and re-run:\n` +
          `  schtasks /Delete /TN ${name} /F`,
      );
    }

    // Read+execute is exactly what /Run and /End need — no write, so the user
    // still cannot redefine the task without elevating.
    const granted = await run([
      "icacls",
      taskFilePath(name),
      "/grant",
      `${userInfo().username}:(RX)`,
    ]);
    return { userCanControlIt: granted.ok };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
