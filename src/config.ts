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
  port: Number(Bun.env.PORT ?? 5150),
  mongo: mongoConfig(),
} as const;
