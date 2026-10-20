import { describe, expect, it } from "vitest";
import {
  loadPricing,
  loadSubscriptions,
  PricingFileSchema,
  SubscriptionsFileSchema,
} from "../src/data/files";

describe("data/pricing.json", () => {
  it("validates against the pricing schema", () => {
    expect(() => loadPricing()).not.toThrow();
  });

  it("rejects overlapping validity ranges for the same model and provider", () => {
    const entry = {
      model: "m",
      provider: "p",
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
    };
    const result = PricingFileSchema.safeParse({
      version: 1,
      currency: "USD",
      entries: [
        { ...entry, validFrom: "2026-01-01", validTo: "2026-06-30" },
        { ...entry, validFrom: "2026-06-01", validTo: null },
      ],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/overlapping validity for m \/ p/);
  });

  it("rejects negative prices", () => {
    const result = PricingFileSchema.safeParse({
      version: 1,
      currency: "USD",
      entries: [
        {
          model: "m",
          provider: "p",
          validFrom: "2026-01-01",
          validTo: null,
          inputPerMTok: -1,
          outputPerMTok: 2,
          cacheReadPerMTok: 0,
          cacheWritePerMTok: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("data/subscriptions.json", () => {
  it("validates against the subscriptions schema", () => {
    expect(() => loadSubscriptions()).not.toThrow();
  });

  it("carries the OpenCode Go limits from spec §5.1", () => {
    const go = loadSubscriptions().plans.find((p) => p.id === "opencode-go");
    expect(go?.windows).toEqual([
      { kind: "five_hours", limit: { unit: "usd", value: 12 } },
      { kind: "weekly", limit: { unit: "usd", value: 30 } },
      { kind: "monthly", limit: { unit: "usd", value: 60 } },
    ]);
  });

  it("marks Claude windows as estimated: no public token limit (spec §5.1)", () => {
    const claude = loadSubscriptions().plans.filter((p) => p.provider === "anthropic");
    expect(claude.length).toBeGreaterThan(0);
    for (const plan of claude) {
      expect(plan.windows.map((w) => w.kind)).toEqual(["five_hours", "weekly"]);
      for (const w of plan.windows) expect(w.limit).toEqual({ unit: "estimated" });
    }
  });

  it("rejects duplicated plan ids", () => {
    const plan = { id: "x", label: "X", provider: "p", windows: [] };
    const result = SubscriptionsFileSchema.safeParse({ version: 1, plans: [plan, plan] });
    expect(result.success).toBe(false);
  });
});
