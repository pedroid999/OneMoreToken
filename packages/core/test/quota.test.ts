import { describe, expect, it } from "vitest";
import type { SubscriptionsFile } from "../src/data/files";
import { computeQuotas, type QuotaInput, type QuotaTurn } from "../src/quota/engine";
import type { CalibrationEntry } from "../src/subscriptions/calibrations";

const plans: SubscriptionsFile = {
  version: 1,
  plans: [
    {
      id: "go-plan",
      label: "Go",
      provider: "opencode",
      monthlyPriceUsd: 10,
      windows: [
        { kind: "five_hours", limit: { unit: "usd", value: 12 } },
        { kind: "weekly", limit: { unit: "usd", value: 30 } },
        { kind: "monthly", limit: { unit: "usd", value: 60 } },
      ],
    },
    {
      id: "est-plan",
      label: "Estimated",
      provider: "anthropic",
      monthlyPriceUsd: 20,
      windows: [
        { kind: "five_hours", limit: { unit: "estimated" } },
        { kind: "weekly", limit: { unit: "estimated" } },
      ],
    },
  ],
};

const go = { id: "go", planId: "go-plan", match: [{ provider: "opencode-go" }] };
const est = { id: "est", planId: "est-plan", match: [{ provider: "claude-bridge" }] };

const turn = (
  subscriptionId: string,
  ts: string,
  cost: Partial<Omit<QuotaTurn, "subscriptionId" | "ts">> = {},
): QuotaTurn => ({
  subscriptionId,
  ts,
  reportedCostUsd: null,
  computedCostUsd: null,
  tokens: 100,
  ...cost,
});

const input = (overrides: Partial<QuotaInput>): QuotaInput => ({
  plans,
  subscriptions: [go],
  turns: [],
  calibrations: [],
  period: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" },
  now: "2026-10-31T00:00:00.000Z",
  ...overrides,
});

const kind = (report: ReturnType<typeof computeQuotas>, id: string, name: string) => {
  const found = report.find((s) => s.id === id)?.windows.find((w) => w.kind === name);
  if (!found) throw new Error(`missing ${id}/${name}`);
  return found;
};

describe("computeQuotas windows", () => {
  it("opens a 5 h window at the first attributed turn after the previous one expired", () => {
    const report = computeQuotas(
      input({
        turns: [
          turn("go", "2026-10-10T10:00:00Z", { reportedCostUsd: 1 }),
          turn("go", "2026-10-10T14:59:59Z", { reportedCostUsd: 2 }),
          turn("go", "2026-10-10T15:30:00Z", { reportedCostUsd: 4 }),
        ],
      }),
    );
    const windows = kind(report, "go", "five_hours").windows;
    expect(windows.map((w) => [w.startsAt, w.endsAt, w.usedUsd, w.usedTokens])).toEqual([
      ["2026-10-10T10:00:00.000Z", "2026-10-10T15:00:00.000Z", 3, 200],
      ["2026-10-10T15:30:00.000Z", "2026-10-10T20:30:00.000Z", 4, 100],
    ]);
  });

  it("opens weekly windows the same way", () => {
    const report = computeQuotas(
      input({
        turns: [
          turn("go", "2026-10-01T08:00:00Z", { reportedCostUsd: 1 }),
          turn("go", "2026-10-07T08:00:00Z", { reportedCostUsd: 1 }),
          turn("go", "2026-10-09T08:00:00Z", { reportedCostUsd: 1 }),
        ],
      }),
    );
    expect(
      kind(report, "go", "weekly").windows.map((w) => [w.startsAt, w.endsAt, w.usedUsd]),
    ).toEqual([
      ["2026-10-01T08:00:00.000Z", "2026-10-08T08:00:00.000Z", 2],
      ["2026-10-09T08:00:00.000Z", "2026-10-16T08:00:00.000Z", 1],
    ]);
  });

  it("anchors monthly windows on the subscription startedAt day", () => {
    const report = computeQuotas(
      input({
        subscriptions: [{ ...go, startedAt: "2026-09-15" }],
        turns: [
          turn("go", "2026-10-10T08:00:00Z", { reportedCostUsd: 5 }),
          turn("go", "2026-10-20T08:00:00Z", { reportedCostUsd: 7 }),
        ],
      }),
    );
    expect(
      kind(report, "go", "monthly").windows.map((w) => [w.startsAt, w.endsAt, w.usedUsd]),
    ).toEqual([
      ["2026-09-15T00:00:00.000Z", "2026-10-15T00:00:00.000Z", 5],
      ["2026-10-15T00:00:00.000Z", "2026-11-15T00:00:00.000Z", 7],
    ]);
  });

  it("only returns windows that overlap the period", () => {
    const report = computeQuotas(
      input({
        turns: [
          turn("go", "2026-09-20T08:00:00Z", { reportedCostUsd: 1 }),
          turn("go", "2026-10-10T08:00:00Z", { reportedCostUsd: 1 }),
        ],
      }),
    );
    expect(kind(report, "go", "five_hours").windows.map((w) => w.startsAt)).toEqual([
      "2026-10-10T08:00:00.000Z",
    ]);
  });

  it("marks every window figure as estimated", () => {
    const report = computeQuotas(
      input({
        subscriptions: [go, est],
        turns: [
          turn("go", "2026-10-30T22:00:00Z", { reportedCostUsd: 1 }),
          turn("est", "2026-10-30T22:00:00Z", { computedCostUsd: 1 }),
        ],
      }),
    );
    for (const subscription of report) {
      for (const window of subscription.windows) {
        expect(window.windows.length).toBeGreaterThan(0);
        for (const figure of window.windows) expect(figure.estimated).toBe(true);
        expect(window.current?.estimated).toBe(true);
        if (window.projection) expect(window.projection.estimated).toBe(true);
      }
    }
  });
});

describe("computeQuotas usage and limits", () => {
  it("measures usd plans with reported cost, else computed, against the plan limit", () => {
    const report = computeQuotas(
      input({
        turns: [
          turn("go", "2026-10-10T10:00:00Z", { reportedCostUsd: 3, computedCostUsd: 100 }),
          turn("go", "2026-10-10T11:00:00Z", { computedCostUsd: 3 }),
        ],
      }),
    );
    const five = kind(report, "go", "five_hours");
    expect(five.unit).toBe("usd");
    expect(five.limitSource).toBe("plan");
    expect(five.limitUsd).toBe(12);
    expect(five.windows[0]).toMatchObject({
      usedUsd: 6,
      limitUsd: 12,
      estimatedPct: 50,
      overLimitUsd: 0,
      limitSource: "plan",
    });
  });

  it("records usage beyond 100% of a usd limit as over-limit", () => {
    const report = computeQuotas(
      input({
        turns: [
          turn("go", "2026-10-10T10:00:00Z", { reportedCostUsd: 10 }),
          turn("go", "2026-10-10T11:00:00Z", { reportedCostUsd: 5 }),
          turn("go", "2026-10-11T10:00:00Z", { reportedCostUsd: 2 }),
        ],
      }),
    );
    const five = kind(report, "go", "five_hours");
    expect(five.windows.map((w) => w.overLimitUsd)).toEqual([3, 0]);
    expect(five.windows[0]?.estimatedPct).toBe(125);
    expect(five.overLimitUsd).toBe(3);
  });

  it("leaves an estimated plan without calibrations with an unknown limit", () => {
    const report = computeQuotas(
      input({
        subscriptions: [est],
        turns: [turn("est", "2026-10-10T10:00:00Z", { reportedCostUsd: 50, computedCostUsd: 2 })],
      }),
    );
    const five = kind(report, "est", "five_hours");
    expect(five).toMatchObject({ unit: "estimated", limitSource: "unknown", limitUsd: null });
    expect(five.windows[0]).toMatchObject({
      usedUsd: 2,
      limitUsd: null,
      estimatedPct: null,
      overLimitUsd: null,
      limitSource: "unknown",
    });
    expect(five.calibration).toEqual({ readings: [], meanAbsoluteDeviationPct: null });
  });
});

describe("computeQuotas calibration", () => {
  const reading = (id: string, observedAt: string, observedPct: number): CalibrationEntry => ({
    id,
    subscriptionId: "est",
    windowKind: "five_hours",
    observedAt,
    observedPct,
  });
  const turns = [
    turn("est", "2026-10-10T00:00:00Z", { computedCostUsd: 2 }),
    turn("est", "2026-10-10T02:00:00Z", { computedCostUsd: 5 }),
    turn("est", "2026-10-10T06:00:00Z", { computedCostUsd: 3 }),
    turn("est", "2026-10-10T12:00:00Z", { computedCostUsd: 4 }),
  ];

  it("uses the median implied limit and reports leave-one-out deviation", () => {
    const report = computeQuotas(
      input({
        subscriptions: [est],
        turns,
        calibrations: [
          reading("a", "2026-10-10T01:00:00Z", 20),
          reading("b", "2026-10-10T07:00:00Z", 25),
          reading("c", "2026-10-10T13:00:00Z", 50),
        ],
      }),
    );
    const five = kind(report, "est", "five_hours");
    expect(five.limitSource).toBe("calibrated");
    expect(five.limitUsd).toBe(10);
    expect(five.windows[0]).toMatchObject({
      usedUsd: 7,
      limitUsd: 10,
      estimatedPct: 70,
      limitSource: "calibrated",
    });
    const readings = five.calibration.readings;
    expect(readings.map((r) => [r.id, r.observedPct, r.usedUsd])).toEqual([
      ["a", 20, 2],
      ["b", 25, 3],
      ["c", 50, 4],
    ]);
    expect(readings[0]?.predictedPct).toBeCloseTo(20);
    expect(readings[0]?.deltaPct).toBeCloseTo(0);
    expect(readings[1]?.predictedPct).toBeCloseTo(100 / 3);
    expect(readings[1]?.deltaPct).toBeCloseTo(100 / 3 - 25);
    expect(readings[2]?.predictedPct).toBeCloseTo(400 / 11);
    expect(readings[2]?.deltaPct).toBeCloseTo(400 / 11 - 50);
    expect(five.calibration.meanAbsoluteDeviationPct).toBeCloseTo(
      (0 + (100 / 3 - 25) + (50 - 400 / 11)) / 3,
    );
    // Calibrations of one kind never leak into another.
    expect(kind(report, "est", "weekly").limitSource).toBe("unknown");
  });

  it("calibrates with one reading but reports no deviation", () => {
    const report = computeQuotas(
      input({
        subscriptions: [est],
        turns,
        calibrations: [reading("a", "2026-10-10T01:00:00Z", 20)],
      }),
    );
    const five = kind(report, "est", "five_hours");
    expect(five.limitSource).toBe("calibrated");
    expect(five.limitUsd).toBe(10);
    expect(five.calibration.readings[0]).toMatchObject({ predictedPct: null, deltaPct: null });
    expect(five.calibration.meanAbsoluteDeviationPct).toBeNull();
  });
});

describe("computeQuotas calibration of a plan limit", () => {
  const goReading = (id: string, observedAt: string, observedPct: number): CalibrationEntry => ({
    id,
    subscriptionId: "go",
    windowKind: "five_hours",
    observedAt,
    observedPct,
  });
  const turns = [turn("go", "2026-10-10T10:00:00Z", { reportedCostUsd: 3 })];

  it("keeps the published limit while there are no readings", () => {
    const five = kind(computeQuotas(input({ turns })), "go", "five_hours");
    expect(five).toMatchObject({ limitSource: "plan", limitUsd: 12 });
    expect(five.windows[0]?.estimatedPct).toBe(25);
  });

  it("lets readings correct a published limit the agents' cost does not match", () => {
    const five = kind(
      computeQuotas(input({ turns, calibrations: [goReading("a", "2026-10-10T11:00:00Z", 50)] })),
      "go",
      "five_hours",
    );
    expect(five).toMatchObject({ limitSource: "calibrated", limitUsd: 6 });
    expect(five.windows[0]).toMatchObject({ estimatedPct: 50, limitSource: "calibrated" });
    // A lone reading is predicted from the published limit: its deviation is still honest.
    expect(five.calibration.readings[0]).toMatchObject({ predictedPct: 25, deltaPct: -25 });
    expect(five.calibration.meanAbsoluteDeviationPct).toBe(25);
  });

  it("predicts each reading from the other readings once there are two", () => {
    const five = kind(
      computeQuotas(
        input({
          turns: [...turns, turn("go", "2026-10-10T12:00:00Z", { reportedCostUsd: 1 })],
          calibrations: [
            goReading("a", "2026-10-10T11:00:00Z", 50),
            goReading("b", "2026-10-10T13:00:00Z", 40),
          ],
        }),
      ),
      "go",
      "five_hours",
    );
    expect(five.limitUsd).toBe(8);
    expect(five.calibration.readings.map((r) => r.predictedPct)).toEqual([30, 100 * (4 / 6)]);
    expect(five.calibration.meanAbsoluteDeviationPct).toBeCloseTo((20 + (400 / 6 - 40)) / 2);
  });
});

describe("computeQuotas pace projection", () => {
  const at = (now: string, cost: number) =>
    kind(
      computeQuotas(
        input({ now, turns: [turn("go", "2026-10-10T10:00:00Z", { reportedCostUsd: cost })] }),
      ),
      "go",
      "five_hours",
    );

  it("projects when the limit is reached before the reset at the current pace", () => {
    const five = at("2026-10-10T11:00:00Z", 6);
    expect(five.current?.startsAt).toBe("2026-10-10T10:00:00.000Z");
    expect(five.resetsAt).toBe("2026-10-10T15:00:00.000Z");
    expect(five.projection).toEqual({
      projectedLimitAt: "2026-10-10T12:00:00.000Z",
      reached: false,
      estimated: true,
    });
  });

  it("returns null when the pace never reaches the limit before the reset", () => {
    expect(at("2026-10-10T11:00:00Z", 1).projection?.projectedLimitAt).toBeNull();
  });

  it("flags a limit already reached", () => {
    expect(at("2026-10-10T11:00:00Z", 13).projection).toEqual({
      projectedLimitAt: null,
      reached: true,
      estimated: true,
    });
  });

  it("has no current window once the last one expired", () => {
    const five = at("2026-10-10T16:00:00Z", 6);
    expect(five.current).toBeNull();
    expect(five.resetsAt).toBeNull();
    expect(five.projection).toBeNull();
  });
});

describe("computeQuotas extracted value", () => {
  it("compares API-equivalent cost with the prorated monthly price over the active period", () => {
    const report = computeQuotas(
      input({
        subscriptions: [{ ...est, startedAt: "2026-10-06" }],
        period: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-16T00:00:00.000Z" },
        turns: [
          turn("est", "2026-10-07T10:00:00Z", { computedCostUsd: 12, reportedCostUsd: 1 }),
          turn("est", "2026-10-08T10:00:00Z", { computedCostUsd: null }),
          turn("est", "2026-10-20T10:00:00Z", { computedCostUsd: 99 }),
        ],
      }),
    );
    const value = report[0]?.extractedValue;
    const paid = (20 * 10) / (365.25 / 12);
    expect(value?.apiEquivalentUsd).toBe(12);
    expect(value?.unpricedTurns).toBe(1);
    expect(value?.paidUsd).toBeCloseTo(paid);
    expect(value?.ratio).toBeCloseTo(12 / paid);
  });

  it("has no paid amount when the plan has no monthly price", () => {
    const report = computeQuotas(
      input({
        plans: {
          version: 1,
          plans: [
            { ...(plans.plans[0] as SubscriptionsFile["plans"][number]), monthlyPriceUsd: null },
          ],
        },
      }),
    );
    expect(report[0]?.extractedValue).toMatchObject({ paidUsd: null, ratio: null });
  });
});
