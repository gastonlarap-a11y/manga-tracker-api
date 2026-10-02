import { prisma } from "../../db/client";

/** The one row there is; see `ExtensionSettings` in the schema. */
const SETTINGS_ID = 1;

export type ExtensionSettings = {
  readingRequired: boolean;
  readMinSeconds: number;
  readMinScrollPercent: number;
};

/**
 * What an absent row means. Kept equal to the column defaults in the schema,
 * which a test holds it to: the two answer the same question for a machine
 * that never touched the setting and for one that did.
 */
export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  readingRequired: false,
  readMinSeconds: 30,
  readMinScrollPercent: 80,
};

export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const row = await prisma.extensionSettings.findUnique({
    where: { id: SETTINGS_ID },
  });
  if (row === null) {
    return DEFAULT_EXTENSION_SETTINGS;
  }
  return {
    readingRequired: row.readingRequired,
    readMinSeconds: row.readMinSeconds,
    readMinScrollPercent: row.readMinScrollPercent,
  };
}

/** Replaces all three values: the dashboard always sends the whole form. */
export async function saveExtensionSettings(
  settings: ExtensionSettings,
): Promise<ExtensionSettings> {
  const data = { ...settings, updatedAt: new Date() };
  await prisma.extensionSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...data },
    update: data,
  });
  return settings;
}
