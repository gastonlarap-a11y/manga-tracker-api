/** Shared console vocabulary, so four scripts read as one tool. */

export const heading = (text: string): void => console.log(`\n${text}`);
export const step = (text: string): void => console.log(`• ${text}`);
export const done = (text: string): void => console.log(`✓ ${text}`);
export const warn = (text: string): void => console.warn(`! ${text}`);

/** Prints the reason plus what to do about it, then stops. */
export function fail(reason: string, remedy?: string): never {
  console.error(`\n✗ ${reason}`);
  if (remedy !== undefined) {
    console.error(`\n${remedy}`);
  }
  process.exit(1);
}

/**
 * Turns an escaped error into the same one-line report as `fail`. Called at the
 * top of each script: an operator tool that answers a rejected Azure request
 * with a Bun stack trace buries the one sentence that says what to do.
 */
export function installErrorHandler(): void {
  const report = (error: unknown): never =>
    fail(error instanceof Error ? error.message : String(error));
  process.on("uncaughtException", report);
  process.on("unhandledRejection", report);
}
