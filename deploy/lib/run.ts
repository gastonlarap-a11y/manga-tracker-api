/**
 * Every external command these scripts run goes through a `Runner`, so the
 * command construction and the branching around exit codes can be tested
 * without an Azure subscription, a Keychain or a launchd session — the same
 * reason `sync.fake-target.ts` exists for the Mongo driver.
 */

export interface CommandResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Runner = (command: readonly string[]) => Promise<CommandResult>;

/** Runs the command for real. stdout/stderr are captured, never inherited. */
export const spawnRunner: Runner = async (command) => {
  const [bin, ...rest] = command;
  if (bin === undefined) {
    throw new Error("spawnRunner called with an empty command");
  }
  const proc = Bun.spawn([bin, ...rest], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() };
};

/**
 * For the long steps of a deploy — lint, tests, migrations — where watching the
 * output matters more than capturing it. Not a `Runner`: nothing branches on
 * what these print, only on whether they passed.
 */
export async function runVisible(
  command: readonly string[],
  env?: Record<string, string>,
): Promise<boolean> {
  const [bin, ...rest] = command;
  if (bin === undefined) {
    throw new Error("runVisible called with an empty command");
  }
  const proc = Bun.spawn([bin, ...rest], {
    stdout: "inherit",
    stderr: "inherit",
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return (await proc.exited) === 0;
}

export interface FakeResponse {
  /** Matched against the start of the command, so args can be ignored. */
  readonly when: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

export interface FakeRunner {
  readonly run: Runner;
  /** Every command received, in order. */
  readonly calls: readonly (readonly string[])[];
}

const startsWith = (command: readonly string[], prefix: readonly string[]) =>
  prefix.every((part, index) => command[index] === part);

/**
 * The first response whose `when` prefixes the command wins. An unmatched
 * command fails loudly instead of returning a benign default: a test that
 * silently exercises a branch nobody stubbed is worse than a red one.
 */
export function createFakeRunner(
  responses: readonly FakeResponse[],
): FakeRunner {
  const calls: (readonly string[])[] = [];
  return {
    calls,
    run: async (command) => {
      calls.push(command);
      const match = responses.find((response) =>
        startsWith(command, response.when),
      );
      if (match === undefined) {
        throw new Error(
          `fake runner has no response for: ${command.join(" ")}`,
        );
      }
      const code = match.code ?? 0;
      return {
        ok: code === 0,
        code,
        stdout: match.stdout ?? "",
        stderr: match.stderr ?? "",
      };
    },
  };
}
