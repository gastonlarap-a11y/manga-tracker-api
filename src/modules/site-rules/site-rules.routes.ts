import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook } from "../../lib/http";
import { SITE_RULES } from "../../lib/site-rules";
import { listAdapters } from "../adapters/adapters.service";

const seriesRuleSchema = z
  .object({
    pattern: z.string(),
    template: z.string(),
    navigable: z.boolean(),
  })
  .openapi("SeriesRule");

const siteRuleSchema = z
  .object({
    domain: z.string(),
    series: seriesRuleSchema.nullable(),
    // The calibrated half, absent for a curated rule nobody has calibrated.
    titleSelector: z.string().nullable(),
    chapterSelector: z.string().nullable(),
    chapterUrlRegex: z.string().nullable(),
  })
  .openapi("SiteRule");

const listRoute = createRoute({
  method: "get",
  path: "/site-rules",
  tags: ["site-rules"],
  responses: {
    200: {
      description:
        "Everything the extension needs to know about sites: the curated catalogue plus this machine's own calibrations",
      content: { "application/json": { schema: z.array(siteRuleSchema) } },
    },
  },
});

/**
 * One list, fetched once and cached, instead of a request per page load.
 *
 * The curated catalogue travels in the server precisely so a new site does not
 * cost an extension release, and a calibration the user made on this machine
 * overrides it: the person looking at the page knows better than a rule written
 * months ago against a layout the site may since have changed.
 */
export const siteRulesRoutes = new OpenAPIHono({ defaultHook }).openapi(
  listRoute,
  async (c) => {
    const adapters = await listAdapters();
    const byDomain = new Map<string, z.infer<typeof siteRuleSchema>>();

    for (const rule of SITE_RULES) {
      byDomain.set(rule.domain, {
        domain: rule.domain,
        series: rule.series,
        titleSelector: null,
        chapterSelector: null,
        chapterUrlRegex: null,
      });
    }
    for (const adapter of adapters) {
      const curated = byDomain.get(adapter.domain);
      byDomain.set(adapter.domain, {
        domain: adapter.domain,
        // A calibration says nothing about series identity, so the curated rule
        // survives one being saved for the same site.
        series: curated?.series ?? null,
        titleSelector: adapter.titleSelector,
        chapterSelector: adapter.chapterSelector,
        chapterUrlRegex: adapter.chapterUrlRegex,
      });
    }

    return c.json([...byDomain.values()], 200);
  },
);
