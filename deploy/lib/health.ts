/**
 * Polling the app's own health endpoint. Not specific to any platform: a
 * launchd job and a scheduled task are both just a process listening on
 * 127.0.0.1 once they are up.
 */

export interface HealthReport {
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Polls until the service manager has actually started the process. A single
 * immediate request would race the restart and report a false failure.
 */
export async function waitForHealth(
  port: number,
  attempts = 15,
  delayMs = 1000,
): Promise<HealthReport> {
  let detail = "no response";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.text();
      if (response.ok && body.includes('"ok"')) {
        return { ok: true, detail: body };
      }
      detail = `HTTP ${response.status}: ${body}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(delayMs);
  }
  return { ok: false, detail };
}
