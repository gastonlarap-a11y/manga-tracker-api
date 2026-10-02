import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
  EXTENSION_CATALOGUE,
  EXTENSION_CONFIG_SCHEMA_VERSION,
} from "../../lib/extension-config";
import { defaultHook, errorSchema } from "../../lib/http";
import {
  getExtensionSettings,
  saveExtensionSettings,
} from "./extension.service";

const extensionSettingsSchema = z
  .object({
    readingRequired: z.boolean(),
    // An hour is far past any chapter; past that the number is a typo.
    readMinSeconds: z.number().int().min(0).max(3600),
    readMinScrollPercent: z.number().int().min(0).max(100),
  })
  .openapi("ExtensionSettings");

const detectionTuningSchema = z
  .object({
    // Null keeps the extension's compiled default.
    confidenceThreshold: z.number().nullable(),
    settleDelayMs: z.number().int().nullable(),
    chapterUrlPatterns: z.array(z.string()),
    readerPathPatterns: z.array(z.string()),
    chapterWords: z.array(z.string()),
    sectionSegments: z.array(z.string()),
    leadingPrefixes: z.array(z.string()),
  })
  .openapi("DetectionTuning");

const siteThemeSchema = z
  .object({
    name: z.string(),
    readerMarker: z.string(),
    headingSelector: z.string().nullable(),
    seriesLinkSelector: z.string().nullable(),
    nextSelector: z.string().nullable(),
  })
  .openapi("SiteTheme");

const extensionNoticeSchema = z
  .object({
    id: z.string(),
    level: z.enum(["info", "warning"]),
    text: z.string(),
  })
  .openapi("ExtensionNotice");

const extensionConfigSchema = z
  .object({
    schemaVersion: z.number().int(),
    minExtensionVersion: z.string(),
    detection: detectionTuningSchema,
    themes: z.array(siteThemeSchema),
    notices: z.array(extensionNoticeSchema),
    reading: extensionSettingsSchema,
  })
  .openapi("ExtensionConfig");

const configRoute = createRoute({
  method: "get",
  path: "/extension-config",
  tags: ["extension"],
  responses: {
    200: {
      description:
        "Detection tuning, site themes, notices and reading settings for the extension, fetched once and cached",
      content: { "application/json": { schema: extensionConfigSchema } },
    },
  },
});

const getSettingsRoute = createRoute({
  method: "get",
  path: "/extension-settings",
  tags: ["extension"],
  responses: {
    200: {
      description: "When the extension counts a chapter as read",
      content: { "application/json": { schema: extensionSettingsSchema } },
    },
  },
});

const putSettingsRoute = createRoute({
  method: "put",
  path: "/extension-settings",
  tags: ["extension"],
  request: {
    // Required so a non-JSON body is refused, not {} and a 500: see events.routes.ts.
    body: {
      required: true,
      content: { "application/json": { schema: extensionSettingsSchema } },
    },
  },
  responses: {
    200: {
      description: "Settings replaced",
      content: { "application/json": { schema: extensionSettingsSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorSchema } },
    },
  },
});

/**
 * Everything the extension is told about detection, in one request.
 *
 * The catalogue is curated in `lib/extension-config.ts`; the reading settings
 * are this machine's, edited from the dashboard. They travel together because
 * the extension reads them at the same moment — when a page settles — and one
 * cached answer is cheaper than two.
 */
export const extensionRoutes = new OpenAPIHono({ defaultHook })
  .openapi(configRoute, async (c) => {
    const { detection, themes, notices, minExtensionVersion } =
      EXTENSION_CATALOGUE;
    return c.json(
      {
        schemaVersion: EXTENSION_CONFIG_SCHEMA_VERSION,
        minExtensionVersion,
        detection: {
          confidenceThreshold: detection.confidenceThreshold ?? null,
          settleDelayMs: detection.settleDelayMs ?? null,
          chapterUrlPatterns: [...detection.chapterUrlPatterns],
          readerPathPatterns: [...detection.readerPathPatterns],
          chapterWords: [...detection.chapterWords],
          sectionSegments: [...detection.sectionSegments],
          leadingPrefixes: [...detection.leadingPrefixes],
        },
        themes: themes.map((theme) => ({
          name: theme.name,
          readerMarker: theme.readerMarker,
          headingSelector: theme.headingSelector ?? null,
          seriesLinkSelector: theme.seriesLinkSelector ?? null,
          nextSelector: theme.nextSelector ?? null,
        })),
        notices: [...notices],
        reading: await getExtensionSettings(),
      },
      200,
    );
  })
  .openapi(getSettingsRoute, async (c) =>
    c.json(await getExtensionSettings(), 200),
  )
  .openapi(putSettingsRoute, async (c) =>
    c.json(await saveExtensionSettings(c.req.valid("json")), 200),
  );
