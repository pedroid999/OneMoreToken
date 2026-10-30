import { describe, expect, it } from "vitest";
import type { QuotaSubscriptionReport, QuotaWindowKindReport } from "../src/quotas/contract";
import {
  deviationOf,
  overLimitRows,
  paceOf,
  parseQuotasPeriod,
  quotasRequest,
  timelineRows,
  timelineSpec,
  toLocalInput,
  usageLevel,
  validateCalibration,
  windowKey,
} from "../src/quotas/state";

const window = (startsAt: string, endsAt: string, pct: number | null, over: number | null = 0) => ({
  startsAt,
  endsAt,
  usedUsd: 1,
  usedTokens: 10,
  limitUsd: pct === null ? null : 12,
  limitTokens: null,
  estimatedPct: pct,
  overLimitUsd: over,
  limitSource: pct === null ? ("unknown" as const) : ("plan" as const),
  estimated: true as const,
});

const kind = (patch: Partial<QuotaWindowKindReport> = {}): QuotaWindowKindReport => ({
  kind: "five_hours",
  unit: "usd",
  limitSource: "plan",
  limitUsd: 12,
  limitTokens: null,
  windows: [],
  current: null,
  resetsAt: null,
  projection: null,
  overLimitUsd: 0,
  calibration: { readings: [], meanAbsoluteDeviationPct: null },
  ...patch,
});

describe("quotas period and request", () => {
  it("defaults to the last 7 days before the anchor and keeps explicit bounds as written", () => {
    const anchor = Date.parse("2026-01-08T00:00:00.000Z");
    expect(parseQuotasPeriod("", anchor)).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-08T00:00:00.000Z",
    });
    expect(parseQuotasPeriod("?from=a&to=b&agent=pi", anchor)).toEqual({ from: "a", to: "b" });
  });

  it("requests only the period", () => {
    expect(
      quotasRequest({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" }),
    ).toBe("/api/quotas?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-08T00%3A00%3A00.000Z");
  });
});

describe("usageLevel", () => {
  it("maps the estimated % to a colour level, unknown without a limit", () => {
    expect(usageLevel(null)).toBe("unknown");
    expect(usageLevel(0)).toBe("ok");
    expect(usageLevel(69.9)).toBe("ok");
    expect(usageLevel(70)).toBe("warn");
    expect(usageLevel(99.9)).toBe("warn");
    expect(usageLevel(100)).toBe("over");
    expect(usageLevel(140)).toBe("over");
  });
});

describe("windowKey", () => {
  it("names each window kind with its catalog key", () => {
    expect(windowKey("five_hours")).toBe("fiveHours");
    expect(windowKey("weekly")).toBe("weekly");
    expect(windowKey("monthly")).toBe("monthly");
  });
});

describe("paceOf", () => {
  it("is unavailable without a projection (no current window or unknown limit)", () => {
    expect(paceOf(kind())).toEqual({ kind: "unavailable" });
  });

  it("reports reached, projected time, or not before reset", () => {
    expect(
      paceOf(kind({ projection: { projectedLimitAt: null, reached: true, estimated: true } })),
    ).toEqual({ kind: "reached" });
    expect(
      paceOf(
        kind({
          projection: {
            projectedLimitAt: "2026-01-02T03:00:00.000Z",
            reached: false,
            estimated: true,
          },
        }),
      ),
    ).toEqual({ kind: "projected", at: "2026-01-02T03:00:00.000Z" });
    expect(
      paceOf(kind({ projection: { projectedLimitAt: null, reached: false, estimated: true } })),
    ).toEqual({ kind: "notBeforeReset" });
  });
});

describe("timelineRows", () => {
  it("keeps window order and adds the level of each window", () => {
    const rows = timelineRows(
      kind({
        windows: [
          window("2026-01-01T00:00:00.000Z", "2026-01-01T05:00:00.000Z", 50),
          window("2026-01-01T06:00:00.000Z", "2026-01-01T11:00:00.000Z", 120, 2.4),
          window("2026-01-01T12:00:00.000Z", "2026-01-01T17:00:00.000Z", null, null),
        ],
      }),
    );
    expect(rows).toEqual([
      { start: "2026-01-01T00:00:00.000Z", end: "2026-01-01T05:00:00.000Z", pct: 50, level: "ok" },
      {
        start: "2026-01-01T06:00:00.000Z",
        end: "2026-01-01T11:00:00.000Z",
        pct: 120,
        level: "over",
      },
      {
        start: "2026-01-01T12:00:00.000Z",
        end: "2026-01-01T17:00:00.000Z",
        pct: null,
        level: "unknown",
      },
    ]);
  });
});

describe("overLimitRows", () => {
  it("lists windows with usage beyond the limit, newest first, across window kinds", () => {
    const subscription = {
      windows: [
        kind({
          windows: [
            window("2026-01-01T00:00:00.000Z", "2026-01-01T05:00:00.000Z", 120, 2.4),
            window("2026-01-01T06:00:00.000Z", "2026-01-01T11:00:00.000Z", 80, 0),
          ],
        }),
        kind({
          kind: "weekly",
          windows: [window("2025-12-29T00:00:00.000Z", "2026-01-05T00:00:00.000Z", 110, 3)],
        }),
      ],
    } as unknown as QuotaSubscriptionReport;
    expect(overLimitRows(subscription)).toEqual([
      {
        kind: "five_hours",
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-01T05:00:00.000Z",
        overLimitUsd: 2.4,
      },
      {
        kind: "weekly",
        startsAt: "2025-12-29T00:00:00.000Z",
        endsAt: "2026-01-05T00:00:00.000Z",
        overLimitUsd: 3,
      },
    ]);
  });
});

describe("deviationOf", () => {
  it("needs at least 2 readings", () => {
    expect(deviationOf(kind())).toEqual({ kind: "needsMore", readings: 0 });
    expect(
      deviationOf(
        kind({
          calibration: {
            readings: [
              {
                id: "a",
                observedAt: "2026-01-01T01:00:00.000Z",
                observedPct: 10,
                usedUsd: 1,
                usedTokens: 1,
                predictedPct: null,
                deltaPct: null,
              },
            ],
            meanAbsoluteDeviationPct: null,
          },
        }),
      ),
    ).toEqual({ kind: "needsMore", readings: 1 });
  });

  it("reports the mean absolute deviation in percentage points", () => {
    expect(
      deviationOf(kind({ calibration: { readings: [], meanAbsoluteDeviationPct: 1.5 } })),
    ).toEqual({ kind: "ready", meanPct: 1.5 });
  });
});

describe("toLocalInput", () => {
  it("formats an instant as a local datetime-local value", () => {
    const date = new Date(2026, 0, 2, 3, 4, 59);
    expect(toLocalInput(date.getTime())).toBe("2026-01-02T03:04");
  });
});

describe("validateCalibration", () => {
  const now = new Date(2026, 0, 2, 12, 0).getTime();
  const context = { subscriptionId: "claude-pro", kinds: ["five_hours", "weekly"] as const, now };
  const draft = {
    windowKind: "five_hours",
    observedPct: "42.5",
    observedAt: "2026-01-02T11:30",
    note: "  console  ",
  };

  it("builds the POST body with an ISO time and a trimmed note", () => {
    expect(validateCalibration(draft, context)).toEqual({
      ok: true,
      input: {
        subscriptionId: "claude-pro",
        windowKind: "five_hours",
        observedAt: new Date(2026, 0, 2, 11, 30).toISOString(),
        observedPct: 42.5,
        note: "console",
      },
    });
  });

  it("accepts a decimal comma and omits an empty note", () => {
    const result = validateCalibration({ ...draft, observedPct: "7,5", note: " " }, context);
    expect(result).toEqual({
      ok: true,
      input: {
        subscriptionId: "claude-pro",
        windowKind: "five_hours",
        observedAt: new Date(2026, 0, 2, 11, 30).toISOString(),
        observedPct: 7.5,
      },
    });
  });

  it("accepts the 0 and 100 boundaries", () => {
    expect(validateCalibration({ ...draft, observedPct: "0" }, context).ok).toBe(true);
    expect(validateCalibration({ ...draft, observedPct: "100" }, context).ok).toBe(true);
  });

  it("rejects a window kind the plan does not have", () => {
    expect(validateCalibration({ ...draft, windowKind: "monthly" }, context)).toEqual({
      ok: false,
      errors: { windowKind: "burnRate.calibration.errors.windowKind" },
    });
  });

  it("rejects a % outside 0-100 or not a number", () => {
    for (const observedPct of ["", "abc", "-1", "100.1", "150"]) {
      expect(validateCalibration({ ...draft, observedPct }, context)).toEqual({
        ok: false,
        errors: { observedPct: "burnRate.calibration.errors.observedPct" },
      });
    }
  });

  it("rejects a missing time and a time more than 5 minutes in the future", () => {
    expect(validateCalibration({ ...draft, observedAt: "" }, context)).toEqual({
      ok: false,
      errors: { observedAt: "burnRate.calibration.errors.observedAt" },
    });
    expect(validateCalibration({ ...draft, observedAt: "2026-01-02T12:05" }, context).ok).toBe(
      true,
    );
    expect(validateCalibration({ ...draft, observedAt: "2026-01-02T12:06" }, context)).toEqual({
      ok: false,
      errors: { observedAt: "burnRate.calibration.errors.observedAtFuture" },
    });
  });

  it("rejects a note longer than 200 characters and reports every invalid field", () => {
    expect(
      validateCalibration(
        { windowKind: "", observedPct: "x", observedAt: "", note: "n".repeat(201) },
        context,
      ),
    ).toEqual({
      ok: false,
      errors: {
        windowKind: "burnRate.calibration.errors.windowKind",
        observedPct: "burnRate.calibration.errors.observedPct",
        observedAt: "burnRate.calibration.errors.observedAt",
        note: "burnRate.calibration.errors.note",
      },
    });
  });
});

describe("timelineSpec", () => {
  const labels = {
    time: "Time",
    level: "Level",
    consumption: "Consumption",
    levels: { ok: "ok", warn: "warn", over: "over", unknown: "unknown" },
    colors: { ok: "#1", warn: "#2", over: "#3", unknown: "#4" },
  };

  it("spans the selected period, so one window never fills the whole chart", () => {
    const spec = timelineSpec({
      ...labels,
      period: { from: "2026-10-23T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z" },
    }) as { encoding: { x: { scale?: Record<string, number> } } };
    expect(spec.encoding.x.scale).toEqual({
      domainMin: Date.parse("2026-10-23T00:00:00.000Z"),
      domainMax: Date.parse("2026-10-30T00:00:00.000Z"),
    });
  });
});
