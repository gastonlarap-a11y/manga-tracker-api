import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { SiteAdapter } from "../../generated/prisma/client";
import { defaultHook, errorSchema } from "../../lib/http";
import { getAdapterByDomain, upsertAdapter } from "./adapters.service";

export const siteAdapterSchema = z
  .object({
    id: z.string(),
    domain: z.string(),
    titleSelector: z.string(),
    chapterSelector: z.string().nullable(),
    chapterUrlRegex: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("SiteAdapter");
type SiteAdapterDto = z.infer<typeof siteAdapterSchema>;

const upsertAdapterBodySchema = z
  .object({
    domain: z.string().trim().min(1),
    titleSelector: z.string().trim().min(1),
    chapterSelector: z.string().optional(),
    chapterUrlRegex: z.string().optional(),
  })
  .openapi("UpsertAdapterBody");

function toAdapterDto(adapter: SiteAdapter): SiteAdapterDto {
  return {
    id: adapter.id,
    domain: adapter.domain,
    titleSelector: adapter.titleSelector,
    chapterSelector: adapter.chapterSelector,
    chapterUrlRegex: adapter.chapterUrlRegex,
    createdAt: adapter.createdAt.toISOString(),
    updatedAt: adapter.updatedAt.toISOString(),
  };
}

const getAdapterRoute = createRoute({
  method: "get",
  path: "/adapters/{domain}",
  tags: ["adapters"],
  request: { params: z.object({ domain: z.string().min(1) }) },
  responses: {
    200: {
      description: "Stored scraping config for the domain",
      content: { "application/json": { schema: siteAdapterSchema } },
    },
    404: {
      description: "No adapter stored for this domain",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

const postAdapterRoute = createRoute({
  method: "post",
  path: "/adapters",
  tags: ["adapters"],
  request: {
    body: {
      content: { "application/json": { schema: upsertAdapterBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Adapter created or replaced (one per domain)",
      content: { "application/json": { schema: siteAdapterSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

export const adaptersRoutes = new OpenAPIHono({ defaultHook })
  .openapi(getAdapterRoute, async (c) => {
    const { domain } = c.req.valid("param");
    const adapter = await getAdapterByDomain(domain);
    if (!adapter) {
      return c.json({ error: "Adapter not found" }, 404);
    }
    return c.json(toAdapterDto(adapter), 200);
  })
  .openapi(postAdapterRoute, async (c) => {
    const body = c.req.valid("json");
    const adapter = await upsertAdapter(body);
    return c.json(toAdapterDto(adapter), 200);
  });
