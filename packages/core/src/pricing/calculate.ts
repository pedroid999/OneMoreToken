import { type PricingFile, PricingFileSchema } from "../data/files";
import { type Row, UsageSchema } from "../schema/tables";

export type TokenUsage = Pick<
  Row<"usage">,
  "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"
>;

/** Prices use inclusive UTC calendar dates, as in PricingFileSchema's overlap validation.
 * Unknown prices stay null; reported cost (including zero) is never involved in this calculation.
 */
export function calculateCost(
  usage: TokenUsage,
  provider: string,
  model: string,
  timestamp: string,
  pricing: PricingFile,
): number | null {
  const tokens = UsageSchema.pick({
    input_tokens: true,
    output_tokens: true,
    cache_read_tokens: true,
    cache_write_tokens: true,
  }).parse(usage);
  const date = new Date(timestamp).toISOString().slice(0, 10);
  const entry = PricingFileSchema.parse(pricing).entries.find(
    (row) =>
      row.provider === provider &&
      row.model === model &&
      row.validFrom <= date &&
      (row.validTo === null || date <= row.validTo),
  );
  if (!entry) return null;
  return (
    (tokens.input_tokens * entry.inputPerMTok +
      tokens.output_tokens * entry.outputPerMTok +
      tokens.cache_read_tokens * entry.cacheReadPerMTok +
      tokens.cache_write_tokens * entry.cacheWritePerMTok) /
    1_000_000
  );
}
