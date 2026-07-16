import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { config } from "./config";
import { healthRoutes } from "./modules/health/health.routes";

const app = new OpenAPIHono();

app.use(
  "*",
  cors({
    origin: "http://127.0.0.1:5150",
  }),
);

app.onError((err, c) => {
  console.error(`[Unhandled Error] ${err.message}`, err.stack);
  return c.json(
    {
      success: false,
      message: "Internal Server Error",
    },
    500,
  );
});

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
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
