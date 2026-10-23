import { type PricingFile, PricingFileSchema } from "../data/files";
import { type Row, UsageSchema } from "../schema/tables";

export type TokenUsage = Pick<
  Row<"usage">,
  "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"
> & { cache_write_1h_tokens?: number };

/** Historical files use inclusive UTC event dates. Current-reference files use observedAt:
 * the result is an API-equivalent estimate, not a historical bill or subscription charge.
 * Unknown prices stay null; reported cost (including zero) is never involved.
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
  const longWrites = usage.cache_write_1h_tokens === undefined ? 0 : usage.cache_write_1h_tokens;
  if (!Number.isSafeInteger(longWrites) || longWrites < 0 || longWrites > tokens.cache_write_tokens)
    return null;
  const file = PricingFileSchema.parse(pricing);
  const date =
    file.basis === "current-reference"
      ? (file.observedAt ?? "")
      : new Date(timestamp).toISOString().slice(0, 10);
  const entry = file.entries.find(
    (row) =>
      row.provider === provider &&
      row.model === model &&
      row.validFrom <= date &&
      (row.validTo === null || date <= row.validTo),
  );
  if (!entry) return null;
  // Select the whole-request tier before category weighting; cached prompt tokens count too.
  const prompt = tokens.input_tokens + tokens.cache_read_tokens + tokens.cache_write_tokens;
  const rates =
    entry.longContext && prompt > entry.longContext.inputTokenThreshold ? entry.longContext : entry;
  if (longWrites > 0 && rates.cacheWriteLongPerMTok === undefined) return null;
  return (
    (tokens.input_tokens * rates.inputPerMTok +
      tokens.output_tokens * rates.outputPerMTok +
      tokens.cache_read_tokens * rates.cacheReadPerMTok +
      (tokens.cache_write_tokens - longWrites) * rates.cacheWritePerMTok +
      longWrites * (rates.cacheWriteLongPerMTok ?? 0)) /
    1_000_000
  );
}
