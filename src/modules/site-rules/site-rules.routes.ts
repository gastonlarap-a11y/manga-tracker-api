import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { defaultHook } from "../../lib/http";
import { SITE_RULES, type SiteRule } from "../../lib/site-rules";
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
    // This machine's calibration when there is one, else the curated
    // selectors; null when neither says.
    titleSelector: z.string().nullable(),
    chapterSelector: z.string().nullable(),
    chapterUrlRegex: z.string().nullable(),
    // Curated only, and added after extension 0.1.4 — which ignores them.
    aliases: z.array(z.string()),
    ignorePaths: z.array(z.string()),
    confidenceThreshold: z.number().nullable(),
    settleDelayMs: z.number().int().nullable(),
    seriesLinkSelector: z.string().nullable(),
    nextSelector: z.string().nullable(),
  })
  .openapi("SiteRule");
type SiteRuleDto = z.infer<typeof siteRuleSchema>;

function toSiteRuleDto(rule: SiteRule): SiteRuleDto {
  return {
    domain: rule.domain,
    series: rule.series ?? null,
    titleSelector: rule.titleSelector ?? null,
    chapterSelector: rule.chapterSelector ?? null,
    chapterUrlRegex: null,
    aliases: [...(rule.aliases ?? [])],
    ignorePaths: [...(rule.ignorePaths ?? [])],
    confidenceThreshold: rule.confidenceThreshold ?? null,
    settleDelayMs: rule.settleDelayMs ?? null,
    seriesLinkSelector: rule.seriesLinkSelector ?? null,
    nextSelector: rule.nextSelector ?? null,
  };
}

/** A site nobody curated: only what the calibration says about it. */
function uncuratedRule(domain: string): SiteRuleDto {
  return toSiteRuleDto({ domain, note: "" });
}

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
    const byDomain = new Map<string, SiteRuleDto>();

    for (const rule of SITE_RULES) {
      byDomain.set(rule.domain, toSiteRuleDto(rule));
    }
    for (const adapter of adapters) {
      const curated =
        byDomain.get(adapter.domain) ?? uncuratedRule(adapter.domain);
      byDomain.set(adapter.domain, {
        // A calibration says which element holds the title and nothing else,
        // so everything else the curated rule knows survives one being saved
        // for the same site — series identity above all.
        ...curated,
        titleSelector: adapter.titleSelector,
        chapterSelector: adapter.chapterSelector,
        chapterUrlRegex: adapter.chapterUrlRegex,
      });
    }

    return c.json([...byDomain.values()], 200);
  },
);
