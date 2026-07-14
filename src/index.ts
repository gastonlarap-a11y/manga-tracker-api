import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { config } from "./config";
import { healthRoutes } from "./modules/health/health.routes";

const app = new OpenAPIHono();

app.route("/", healthRoutes);

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
  fetch: app.fetch,
};
