import { prisma } from "../../db/client";
import type { SiteAdapter } from "../../generated/prisma/client";

export interface UpsertAdapterInput {
  domain: string;
  titleSelector: string;
  chapterSelector?: string;
  chapterUrlRegex?: string;
}

// Hostnames are case-insensitive, so the domain key is always lowercased.
export function getAdapterByDomain(
  domain: string,
): Promise<SiteAdapter | null> {
  return prisma.siteAdapter.findUnique({
    where: { domain: domain.toLowerCase() },
  });
}

/**
 * Every calibration on this machine, for the single request the extension makes
 * to learn about sites (`GET /api/site-rules`).
 */
export function listAdapters(): Promise<SiteAdapter[]> {
  return prisma.siteAdapter.findMany({ orderBy: { domain: "asc" } });
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
  };
  return prisma.siteAdapter.upsert({
    where: { domain },
    create: { domain, ...data },
    update: data,
  });
}
