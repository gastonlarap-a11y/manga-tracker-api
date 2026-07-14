import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .openapi("HealthResponse");

const getHealthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["health"],
  responses: {
    200: {
      description: "Service is up",
      content: {
        "application/json": { schema: healthResponseSchema },
      },
    },
  },
});

export const healthRoutes = new OpenAPIHono().openapi(getHealthRoute, (c) =>
  c.json({ status: "ok" as const }, 200),
);
