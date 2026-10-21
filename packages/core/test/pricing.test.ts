import { describe, expect, it } from "vitest";
import { calculateCost, type PricingFile } from "../src/index";

const usage = {
  input_tokens: 1_000_000,
  output_tokens: 2_000_000,
  cache_read_tokens: 3_000_000,
  cache_write_tokens: 4_000_000,
};
const entry = {
  model: "synthetic",
  provider: "test",
  validFrom: "2026-01-01",
  validTo: "2026-01-31",
  inputPerMTok: 1,
  outputPerMTok: 2,
  cacheReadPerMTok: 3,
  cacheWritePerMTok: 4,
};
const pricing: PricingFile = {
  version: 1,
  currency: "USD",
  entries: [entry, { ...entry, validFrom: "2026-02-01", validTo: null, inputPerMTok: 5 }],
};

describe("calculateCost", () => {
  it("prices each token category separately using inclusive UTC validity dates", () => {
    for (const timestamp of ["2026-01-01T00:00:00Z", "2026-01-31T23:59:59Z"]) {
      expect(calculateCost(usage, "test", "synthetic", timestamp, pricing)).toBe(30);
    }
    expect(calculateCost(usage, "test", "synthetic", "2026-02-01T00:00:00Z", pricing)).toBe(34);
    expect(calculateCost(usage, "test", "synthetic", "2026-02-01T01:00:00+02:00", pricing)).toBe(
      30,
    );
    for (const [index, key] of Object.keys(usage).entries()) {
      const single = Object.fromEntries(
        Object.keys(usage).map((k) => [k, k === key ? 1_000_000 : 0]),
      );
      expect(
        calculateCost({ ...usage, ...single }, "test", "synthetic", "2026-01-02", pricing),
      ).toBe(index + 1);
    }
  });

  it("returns null, never a missing-price zero, for unmatched models/providers/dates", () => {
    for (const [provider, model, date] of [
      ["unknown", "synthetic", "2026-01-01"],
      ["test", "unknown", "2026-01-01"],
      ["test", "synthetic", "2025-12-31"],
    ] as const) {
      expect(calculateCost(usage, provider, model, date, pricing)).toBeNull();
    }
    expect(
      calculateCost(usage, "test", "synthetic", "2026-01-01", { ...pricing, entries: [] }),
    ).toBeNull();
    const zero = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    expect(calculateCost(zero, "test", "synthetic", "2026-01-01", pricing)).toBe(0);
  });
});
