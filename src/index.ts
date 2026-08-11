import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { config } from "./config";
import { applyMigrations } from "./db/migrate";
import { allowedOrigins } from "./lib/cors";
import { adaptersRoutes } from "./modules/adapters/adapters.routes";
import { duplicatesRoutes } from "./modules/duplicates/duplicates.routes";
import { eventsRoutes } from "./modules/events/events.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { libraryRoutes } from "./modules/library/library.routes";
import { siteRulesRoutes } from "./modules/site-rules/site-rules.routes";
import { syncRoutes } from "./modules/sync/sync.routes";
import { startSyncScheduler } from "./modules/sync/sync.scheduler";

// Before anything opens a connection: a server that answers /health and then
// fails on the first query is worse than one that refuses to start. Idempotent,
// so the usual case (already up to date) is a read and nothing else.
const migration = applyMigrations(config.databaseUrl, config.migrationsDir);
if (migration.applied.length > 0) {
  console.info(
    `[db] applied ${migration.applied.length} migration(s): ${migration.applied.join(", ")}`,
  );
}

const app = new OpenAPIHono();

// Loopback on the port this process actually listens on, plus every configured
// extension id — see src/lib/cors.ts for why neither can be a literal.
app.use(
  "*",
  cors({
    origin: [
      ...allowedOrigins({
        port: config.port,
        extensionIds: config.extensionIds,
      }),
    ],
  }),
);

app.onError((err, c) => {
  console.error(`[Unhandled Error] ${err.message}`, err.stack);
  return c.json({ error: "Internal Server Error" }, 500);
});

app.route("/", healthRoutes);
app.route("/api", eventsRoutes);
app.route("/api", libraryRoutes);
app.route("/api", adaptersRoutes);
app.route("/api", siteRulesRoutes);
app.route("/api", duplicatesRoutes);
app.route("/api", syncRoutes);

// Off-site replica (Azure DocumentDB). Inert unless MONGODB_URL is set, and it
// never sits in the request path: SQLite remains the source of truth.
startSyncScheduler();

// Dashboard: static build of manga-tracker-dashboard, copied into ./public by
// its `bun run deploy`. Only the known SPA routes fall back to index.html, so
// /api, /docs and /openapi.json keep returning real 404s. Until a build is
// deployed these paths just 404.
app.use("/assets/*", serveStatic({ root: "./public" }));
app.get("/favicon.svg", serveStatic({ path: "./public/favicon.svg" }));
for (const spaPath of ["/", "/manga/:id", "/duplicates"]) {
  app.get(spaPath, serveStatic({ path: "./public/index.html" }));
}

app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "manga-tracker-api",
    version: "0.1.0",
  },
});
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

export default {
  port: config.port,
  hostname: "127.0.0.1",
  // Bun closes idle connections after 10s BY DEFAULT, even mid-stream — that
  // killed the SSE feed between heartbeats. 120s + a 25s heartbeat keeps the
  // stream alive with a wide margin.
  idleTimeout: 120,
  fetch: app.fetch,
};
