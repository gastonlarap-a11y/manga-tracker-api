import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { config } from "./config";
import { adaptersRoutes } from "./modules/adapters/adapters.routes";
import { duplicatesRoutes } from "./modules/duplicates/duplicates.routes";
import { eventsRoutes } from "./modules/events/events.routes";
import { healthRoutes } from "./modules/health/health.routes";
import { libraryRoutes } from "./modules/library/library.routes";

const app = new OpenAPIHono();

app.use(
  "*",
  cors({
    origin: [
      "http://127.0.0.1:5150",
      "http://localhost:5150",
      // manga-tracker-extension: id pinned by the fixed manifest key.
      "chrome-extension://cfjiinlnepkmlaafdclmlpjbmpofplop",
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
app.route("/api", duplicatesRoutes);

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
  fetch: app.fetch,
};
