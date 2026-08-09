/**
 * Which machine-specific implementation a script talks to, chosen once at
 * import time. `macos.ts` and `windows.ts` keep exporting plain functions —
 * each tested on its own with `createFakeRunner` — this file only wires the
 * right set to the shape the four `deploy/*.ts` scripts and `secrets.ts`
 * share, so none of them import `macos.ts`/`windows.ts` directly.
 */
import * as macos from "./macos";
import type { Runner } from "./run";
import * as windows from "./windows";

export interface InstallServiceOptions {
  /** Absolute path of the interpreter that runs the backend. */
  readonly bunPath: string;
  /** What it runs, relative to `workingDirectory`. */
  readonly entry: string;
  readonly workingDirectory: string;
}

export interface InstallServiceOutcome {
  /**
   * False when the definition registered but this account cannot start or stop
   * it afterwards — the Windows ACL case. The install still works; it is the
   * caller's job to say so rather than to pretend everything is fine.
   */
  readonly userCanControlIt: boolean;
}

export interface PlatformAdapter {
  /**
   * The platform whose command names this adapter speaks — `which` vs `where`,
   * brew vs winget. `secrets.ts` reads it from here instead of from
   * `process.platform` so its cascade can be tested from any host: a Windows
   * machine running the suite must still exercise the macOS path with macOS
   * commands. Linux gets the macOS adapter, and the POSIX names fit it too.
   */
  readonly os: NodeJS.Platform;
  /** Identity passed to the service manager (a launchd label / task name). */
  readonly serviceLabel: string;
  readonly configPath: string;
  /** Short noun for the config store, e.g. in `env-show`'s column headers. */
  readonly configLabel: string;
  /** Short noun for the local secret cache, e.g. "keychain" / "dpapi cache". */
  readonly secretCacheLabel: string;
  readonly serviceKind: string;
  /** Verb phrase for dry-run/status output, e.g. "bootout + bootstrap". */
  readonly reloadVerb: string;
  readonly logsHint: string;
  configExists(): Promise<boolean>;
  readConfigEnv(run: Runner, key: string): Promise<string | null>;
  writeConfigEnv(run: Runner, key: string, value: string): Promise<boolean>;
  readSecret(run: Runner): Promise<string | null>;
  writeSecret(run: Runner, value: string): Promise<boolean>;
  reloadService(run: Runner): Promise<void>;
  /**
   * Stops the service and waits until it has really stopped. Separate from
   * reloadService because an update has to replace files the running backend
   * holds open, which on Windows fails while the process is alive.
   */
  stopService(run: Runner): Promise<void>;
  /**
   * Creates the service definition on a machine that has never had one. Every
   * other method here edits something that already exists — which held while a
   * plist was copied by hand once, and stops holding when an installer runs on
   * someone else's computer.
   */
  installService(
    run: Runner,
    options: InstallServiceOptions,
  ): Promise<InstallServiceOutcome>;
}

export const macosAdapter: PlatformAdapter = {
  os: "darwin",
  serviceLabel: macos.LAUNCHD_LABEL,
  configPath: macos.PLIST_PATH,
  configLabel: "plist",
  secretCacheLabel: "keychain",
  serviceKind: "LaunchAgent",
  reloadVerb: "bootout + bootstrap",
  logsHint: "  tail -n 50 ~/Library/Logs/MangaTracker/err.log",
  configExists: () => macos.plistExists(),
  readConfigEnv: (run, key) => macos.readPlistEnv(run, key),
  writeConfigEnv: (run, key, value) => macos.writePlistEnv(run, key, value),
  readSecret: (run) => macos.readKeychain(run),
  writeSecret: (run, value) => macos.writeKeychain(run, value),
  reloadService: (run) => macos.reloadService(run),
  stopService: (run) => macos.stopService(run),
  // launchd agents live in the user's own domain, so nothing here needs
  // elevation and the account can always control what it registered.
  installService: async (_run, options) => {
    await macos.writePlist(options);
    return { userCanControlIt: true };
  },
};

export const windowsAdapter: PlatformAdapter = {
  os: "win32",
  serviceLabel: windows.TASK_NAME,
  configPath: windows.CONFIG_PATH,
  configLabel: "prod.env",
  secretCacheLabel: "dpapi cache",
  serviceKind: "scheduled task",
  reloadVerb: "end + run",
  logsHint: `  Get-Content -Tail 50 '${windows.LOG_PATH}'`,
  configExists: () => windows.configExists(),
  readConfigEnv: (run, key) => windows.readConfigEnv(run, key),
  writeConfigEnv: (run, key, value) => windows.writeConfigEnv(run, key, value),
  readSecret: (run) => windows.readSecret(run),
  writeSecret: (run, value) => windows.writeSecret(run, value),
  reloadService: (run) => windows.reloadService(run),
  stopService: (run) => windows.stopService(run),
  installService: (run, options) => windows.installTask(run, options),
};

export const platform: PlatformAdapter =
  process.platform === "win32" ? windowsAdapter : macosAdapter;
