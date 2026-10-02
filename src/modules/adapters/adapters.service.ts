import { prisma } from "../../db/client";
import type { SiteAdapter } from "../../generated/prisma/client";

export interface UpsertAdapterInput {
  domain: string;
  titleSelector: string;
  chapterSelector?: string;
  chapterUrlRegex?: string;
}

// Hostnames are case-insensitive, so the domain key is always lowercased. A
// removed calibration is a tombstone (see `removeAdapter`): as if absent.
export async function getAdapterByDomain(
  domain: string,
): Promise<SiteAdapter | null> {
  const adapter = await prisma.siteAdapter.findUnique({
    where: { domain: domain.toLowerCase() },
  });
  return adapter?.deletedAt === null ? adapter : null;
}

/**
 * Every calibration on this machine, for the single request the extension makes
 * to learn about sites (`GET /api/site-rules`). Removed ones are left out.
 */
export function listAdapters(): Promise<SiteAdapter[]> {
  return prisma.siteAdapter.findMany({
    where: { deletedAt: null },
    orderBy: { domain: "asc" },
  });
}

/**
 * Takes a calibration back. The row stays, marked removed and stamped, so the
 * removal reaches the shared store and every other machine on the next sync —
 * deleting it would let the next pull bring it straight back. False when the
 * site has no calibration to remove.
 */
export async function removeAdapter(domain: string): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.siteAdapter.updateMany({
    where: { domain: domain.toLowerCase(), deletedAt: null },
    data: { deletedAt: now, updatedAt: now },
  });
  return count > 0;
}

/**
 * Replace semantics per the GUIA ("si ya había una, se reemplaza"): a
 * recalibration replaces the whole config, so omitted optionals clear any
 * previously stored selector.
 */
export function upsertAdapter(input: UpsertAdapterInput): Promise<SiteAdapter> {
  const domain = input.domain.toLowerCase();
  const data = {
    titleSelector: input.titleSelector,
    chapterSelector: input.chapterSelector ?? null,
    chapterUrlRegex: input.chapterUrlRegex ?? null,
    // Stamped by hand rather than by @updatedAt so a document pulled from
    // another machine keeps the timestamp that decides who wins.
    updatedAt: new Date(),
    // Calibrating a site whose calibration was removed brings it back.
    deletedAt: null,
  };
  return prisma.siteAdapter.upsert({
    where: { domain },
    create: { domain, ...data },
    update: data,
  });
}
