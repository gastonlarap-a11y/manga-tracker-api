/**
 * The port the server listens on.
 *
 * It used to be `Number(Bun.env.PORT ?? 5150)`, which turns a typo into `NaN`
 * and lets Bun fail later with a message that does not name the cause. Once an
 * installer writes this value on someone else's machine, an unreadable startup
 * error is the difference between a two-minute fix and an unusable app.
 */

/** What a checkout uses when nothing sets PORT. Every other value is chosen by whoever installs. */
export const DEFAULT_PORT = 5150;

/**
 * The last port an installer may fall back to.
 *
 * This window is a contract, not a preference: the browser extension
 * (`utils/api/discovery.ts`) and the desktop app (`internal/backend/discover.go`)
 * find this server by probing exactly these ports. An installer that picks
 * outside the range produces a backend neither of them can reach.
 */
export const LAST_PORT = 5159;

export function candidatePorts(): number[] {
  const ports: number[] = [];
  for (let port = DEFAULT_PORT; port <= LAST_PORT; port++) {
    ports.push(port);
  }
  return ports;
}

export function parsePort(raw: string | undefined): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") {
    return DEFAULT_PORT;
  }
  const port = Number(trimmed);
  // Port 0 is excluded deliberately: it would make the OS pick, and nothing
  // that has to reach this server afterwards — the extension, the desktop app,
  // the deploy health probe — has a way to learn which port it got.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PORT must be a whole number between 1 and 65535, got "${trimmed}".`,
    );
  }
  return port;
}
