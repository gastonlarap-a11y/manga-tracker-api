import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    // The identity marker. Whoever looks for this backend now has to find it on
    // a port an installer chose, by probing a range — and on a personal machine
    // several other things answer 200 on a loopback port. Without a name in the
    // body, a probe cannot tell them apart and would happily talk to the wrong
    // one.
    service: z.literal("manga-tracker-api"),
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
  c.json({ status: "ok" as const, service: "manga-tracker-api" as const }, 200),
);
