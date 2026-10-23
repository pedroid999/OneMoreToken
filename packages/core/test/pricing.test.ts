import { describe, expect, it } from "vitest";
import { calculateCost, loadPricing, type PricingFile } from "../src/index";

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
  it("uses observed current reference rates for past turns without backdating validity", () => {
    const current = loadPricing();
    expect(current.basis).toBe("current-reference");
    expect(current.observedAt).toBe("2026-10-21");
    expect(current.entries.every((row) => row.validFrom === current.observedAt)).toBe(true);
    for (const provider of ["anthropic", "claude-bridge"]) {
      expect(calculateCost(usage, provider, "claude-opus-5-5", "2025-01-01", current)).toBe(64.6);
      expect(
        calculateCost(usage, provider, "claude-opus-5-5[1m]", "2025-01-01", current),
      ).toBeNull();
    }
    expect(calculateCost(usage, "unknown", "claude-opus-5-5", "2025-01-01", current)).toBeNull();
    expect(
      calculateCost(usage, "openai-codex", "gpt-6.1-sol-extra", "2025-01-01", current),
    ).toBeNull();
  });

  it("weights observed one-hour writes within, not in addition to, aggregate writes", () => {
    const current = loadPricing();
    expect(
      calculateCost(
        { ...usage, cache_write_1h_tokens: 1_000_000 },
        "anthropic",
        "claude-opus-5-5",
        "2025-01-01",
        current,
      ),
    ).toBe(67.6);
    for (const count of [-1, 1.5, Infinity, NaN, 4_000_001, null]) {
      expect(
        calculateCost(
          { ...usage, cache_write_1h_tokens: count as number },
          "anthropic",
          "claude-opus-5-5",
          "2025-01-01",
          current,
        ),
      ).toBeNull();
    }
    expect(
      calculateCost(
        { ...usage, cache_write_1h_tokens: 1 },
        "test",
        "synthetic",
        "2026-01-01",
        pricing,
      ),
    ).toBeNull();
  });

  it.each([
    [272000, 0, 0, 2, 10, 0.1, 2.5],
    [272001, 0, 0, 4, 15, 0.2, 5],
    [100000, 100000, 72000, 2, 10, 0.1, 2.5],
    [100000, 100000, 72001, 4, 15, 0.2, 5],
  ])(
    "selects the request tier from input %i + read %i + write %i, never output",
    (input, read, write, inputRate, outputRate, readRate, writeRate) => {
      for (const output of [0, 1_000_000]) {
        expect(
          calculateCost(
            {
              input_tokens: input,
              output_tokens: output,
              cache_read_tokens: read,
              cache_write_tokens: write,
            },
            "openai-codex",
            "gpt-6.1-sol",
            "2025-01-01",
            loadPricing(),
          ),
        ).toBe(
          (input * inputRate + output * outputRate + read * readRate + write * writeRate) /
            1_000_000,
        );
      }
    },
  );

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
