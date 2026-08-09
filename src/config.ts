import { parseExtensionIds } from "./lib/cors";
import { parsePort } from "./lib/port";

const required = (name: string): string => {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

/** Off-site replica target. Null = the sync module stays completely inert. */
export interface MongoConfig {
  url: string;
  db: string;
}

// The replica is opt-in: with no MONGODB_URL the app behaves exactly as it did
// before sync existed (which is also how CI runs, since it has no cluster).
const mongoConfig = (): MongoConfig | null => {
  const url = Bun.env.MONGODB_URL;
  if (!url) {
    return null;
  }
  return { url, db: Bun.env.MONGODB_DB ?? "mangatracker" };
};

export const config = {
  databaseUrl: required("DATABASE_URL"),
  port: parsePort(Bun.env.PORT),
  // Which extension builds may call this API from a browser. Several at once,
  // because the Web Store assigns an id of its own on publication and the
  // unpacked build has to keep working while machines catch up.
  extensionIds: parseExtensionIds(Bun.env.EXTENSION_IDS),
  mongo: mongoConfig(),
  // Where the committed .sql migrations live. Unset in a checkout, where the
  // default next to the source is right; set by the packaged app, whose server
  // is a single bundled file with no src/ tree above it to walk up from.
  // An empty value means "not configured", never "the current directory" — an
  // env file that declares the key blank must not send the migrator to "".
  migrationsDir: Bun.env.MIGRATIONS_DIR || undefined,
} as const;
