import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WindowKindSchema } from "../schema/tables";

// Prices and quota limits are data, not code (spec §4): they live in data/*.json at the repo root.
export const DATA_DIR = fileURLToPath(new URL("../../../../data", import.meta.url));

/**
 * Data directory for the current runtime. OMT_DATA_DIR wins (packaged installs point it at the
 * bundled copy); without it the repo-relative default applies.
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OMT_DATA_DIR ?? DATA_DIR;
}

const date = z.iso.date();
const price = z.number().nonnegative();

const PriceRatesSchema = z.object({
  inputPerMTok: price,
  outputPerMTok: price,
  cacheReadPerMTok: price,
  cacheWritePerMTok: price,
  cacheWriteLongPerMTok: price.optional(),
});
const PricingEntrySchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  validFrom: date,
  validTo: date.nullable(),
  ...PriceRatesSchema.shape,
  sources: z
    .array(z.url({ protocol: /^https?$/ }))
    .min(1)
    .optional(),
  longContext: PriceRatesSchema.extend({
    inputTokenThreshold: z.number().int().nonnegative(),
  }).optional(),
});

export const PricingFileSchema = z
  .object({
    version: z.literal(1),
    currency: z.literal("USD"),
    basis: z.enum(["historical", "current-reference"]).optional(),
    observedAt: date.optional(),
    entries: z.array(PricingEntrySchema),
  })
  .superRefine((file, ctx) => {
    if (file.basis === "current-reference" && file.observedAt === undefined) {
      ctx.addIssue({ code: "custom", message: "current-reference requires observedAt" });
    }
    if (file.basis !== "current-reference" && file.observedAt !== undefined) {
      ctx.addIssue({ code: "custom", message: "observedAt requires current-reference" });
    }
    const byKey = new Map<string, z.infer<typeof PricingEntrySchema>[]>();
    for (const entry of file.entries) {
      if (entry.validTo !== null && entry.validTo < entry.validFrom) {
        ctx.addIssue({ code: "custom", message: "validTo precedes validFrom" });
      }
      if (
        file.basis === "current-reference" &&
        file.observedAt !== undefined &&
        (entry.validFrom > file.observedAt ||
          (entry.validTo !== null && entry.validTo < file.observedAt))
      ) {
        ctx.addIssue({ code: "custom", message: "reference entry must be valid on observedAt" });
      }
      const key = `${entry.model} / ${entry.provider}`;
      const list = byKey.get(key) ?? [];
      list.push(entry);
      byKey.set(key, list);
    }
    for (const [key, list] of byKey) {
      const sorted = [...list].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
      for (let i = 1; i < sorted.length; i++) {
        const previousEnd = sorted[i - 1]?.validTo;
        const start = sorted[i]?.validFrom ?? "";
        if (previousEnd === null || (previousEnd !== undefined && previousEnd >= start)) {
          ctx.addIssue({ code: "custom", message: `overlapping validity for ${key}` });
        }
      }
    }
  });
export type PricingFile = z.infer<typeof PricingFileSchema>;

const LimitSchema = z.discriminatedUnion("unit", [
  z.object({ unit: z.literal("usd"), value: z.number().positive() }),
  z.object({ unit: z.literal("tokens"), value: z.number().int().positive() }),
  // The provider does not publish the limit: estimate it and calibrate (spec §5.3).
  z.object({ unit: z.literal("estimated") }),
]);

const PlanSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().min(1),
  provider: z.string().min(1),
  monthlyPriceUsd: z.number().nonnegative().nullable().optional(),
  reviewedAt: date.optional(),
  windows: z.array(z.object({ kind: WindowKindSchema, limit: LimitSchema })),
});

export const SubscriptionsFileSchema = z
  .object({ version: z.literal(1), plans: z.array(PlanSchema) })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    for (const plan of file.plans) {
      if (seen.has(plan.id))
        ctx.addIssue({ code: "custom", message: `duplicate plan id ${plan.id}` });
      seen.add(plan.id);
    }
  });
export type SubscriptionsFile = z.infer<typeof SubscriptionsFileSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Canonical tool id: lowercase, stable and safe to use as a group value (spec §7.3). */
const TOOL_ID = /^[a-z][a-z0-9_-]{0,63}$/;

const ToolEntrySchema = z.strictObject({
  id: z.string().regex(TOOL_ID),
  // Every raw name the adapters of this repository emit for this tool; never invented.
  aliases: z.array(z.string().min(1)).min(1),
});

/**
 * `data/tools.json`: raw tool names of every agent mapped to one canonical id (spec §7.3). Matching
 * is case-insensitive, so an alias is unique file-wide ignoring case: two tools claiming the same
 * raw name would make the resolution ambiguous. A raw name without an alias degrades to its
 * lowercase form instead of disappearing.
 */
export const ToolCatalogueSchema = z
  .strictObject({ version: z.literal(1), tools: z.array(ToolEntrySchema) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    const aliases = new Set<string>();
    for (const tool of file.tools) {
      if (ids.has(tool.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate tool id ${tool.id}` });
      }
      ids.add(tool.id);
      for (const alias of tool.aliases) {
        const key = alias.toLowerCase();
        if (aliases.has(key)) {
          ctx.addIssue({ code: "custom", message: `duplicate alias ${key}` });
        }
        aliases.add(key);
      }
    }
  });
export type ToolCatalogue = z.infer<typeof ToolCatalogueSchema>;

export function loadPricing(path = join(resolveDataDir(), "pricing.json")): PricingFile {
  return PricingFileSchema.parse(readJson(path));
}

export function loadSubscriptions(path = join(resolveDataDir(), "subscriptions.json")): SubscriptionsFile {
  return SubscriptionsFileSchema.parse(readJson(path));
}

export function loadToolCatalogue(path = join(resolveDataDir(), "tools.json")): ToolCatalogue {
  return ToolCatalogueSchema.parse(readJson(path));
}

/** Canonical id of a raw tool name: its alias, case-insensitively, else the name lowercased. */
export function canonicalTool(catalogue: ToolCatalogue, raw: string): string {
  const name = raw.toLowerCase();
  for (const tool of catalogue.tools) {
    if (tool.aliases.some((alias) => alias.toLowerCase() === name)) return tool.id;
  }
  return name;
}
