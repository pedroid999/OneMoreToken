import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WindowKindSchema } from "../schema/tables";

// Prices and quota limits are data, not code (spec §4): they live in data/*.json at the repo root.
export const DATA_DIR = fileURLToPath(new URL("../../../../data", import.meta.url));

const date = z.iso.date();
const price = z.number().nonnegative();

const PricingEntrySchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  validFrom: date,
  validTo: date.nullable(),
  inputPerMTok: price,
  outputPerMTok: price,
  cacheReadPerMTok: price,
  cacheWritePerMTok: price,
});

export const PricingFileSchema = z
  .object({
    version: z.literal(1),
    currency: z.literal("USD"),
    entries: z.array(PricingEntrySchema),
  })
  .superRefine((file, ctx) => {
    const byKey = new Map<string, z.infer<typeof PricingEntrySchema>[]>();
    for (const entry of file.entries) {
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

export function loadPricing(path = `${DATA_DIR}/pricing.json`): PricingFile {
  return PricingFileSchema.parse(readJson(path));
}

export function loadSubscriptions(path = `${DATA_DIR}/subscriptions.json`): SubscriptionsFile {
  return SubscriptionsFileSchema.parse(readJson(path));
}
