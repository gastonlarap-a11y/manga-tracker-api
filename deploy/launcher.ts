/**
 * The program the service actually starts, so the cluster password does not
 * have to live in a file.
 *
 * Until now the service ran `index.js` directly, and its connection string came
 * from the service's own configuration — the LaunchAgent plist on macOS, the
 * `prod.env` file on Windows — in plaintext. Locked to the owning account, but
 * plaintext, and permanently. It had to be: launchd's `EnvironmentVariables`
 * and `bun --env-file` both hand the process a string, and neither can decrypt
 * one.
 *
 * So the service starts this instead. It reads the encrypted copy the system
 * already keeps (Keychain, DPAPI), puts the value in the environment in memory,
 * and then runs the server in **this same process** — no child to supervise, no
 * second PID, and the process the service manager watches is still the one
 * serving.
 *
 * The server is untouched by all of this: `src/config.ts` goes on reading
 * `Bun.env.MONGODB_URL` and knows nothing about keystores. Nothing here belongs
 * in `src/`, which has to stay free of platform code.
 */
import { platform } from "./lib/platform";
import { spawnRunner } from "./lib/run";
import { resolveSyncSecret } from "./lib/sync-secret";

/** Bun's entrypoint convention: what `index.js` exports to be served. */
interface ServerConfig {
  port: number;
  hostname: string;
  idleTimeout: number;
  fetch: (request: Request) => Response | Promise<Response>;
}

export async function launch(
  serverPath: string,
  env: Record<string, string | undefined> = Bun.env,
): Promise<void> {
  const resolved = await resolveSyncSecret(env.MONGODB_URL, () =>
    platform.readSecret(spawnRunner),
  );

  if (resolved.url === "") {
    // Deleted rather than left as the sentinel: `config.ts` treats any
    // non-empty value as a connection string, and would hand "keystore" to the
    // driver as if it were one.
    delete process.env.MONGODB_URL;
    if ((env.MONGODB_URL ?? "") !== "") {
      console.error(
        `[launcher] sync is configured but the credential could not be read from the ${platform.secretCacheLabel}; starting without it`,
      );
    }
  } else {
    process.env.MONGODB_URL = resolved.url;
    console.info(`[launcher] sync credential read from the ${resolved.source}`);
  }

  // Imported after the environment is set: `config.ts` reads it at import time,
  // and `index.ts` starts its scheduler and applies its migrations the moment
  // it is loaded.
  //
  // The specifier is a variable so the bundler leaves it alone — index.js is a
  // separate file in the shipped tree, not something to inline here.
  const server = (await import(serverPath)) as { default: ServerConfig };
  Bun.serve(server.default);
}

// Bun starts a server from an entrypoint's default export, and only an
// entrypoint's — a module reached through `import()` is just a module. So the
// serving is done by hand above, which is also why this file is the one the
// service points at.
if (import.meta.main) {
  await launch(new URL("./index.js", import.meta.url).href);
}
