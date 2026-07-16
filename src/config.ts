const required = (name: string): string => {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const config = {
  databaseUrl: required("DATABASE_URL"),
  port: Number(Bun.env.PORT ?? 5150),
} as const;
