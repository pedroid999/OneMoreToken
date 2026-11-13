import { describe, expect, it } from "vitest";
import type { MonthlyReportData, ReportTotals, WeeklyReportData } from "../src/reports/contract";
import en from "../src/reports/i18n/en.json";
import es from "../src/reports/i18n/es.json";
import { lastEndedMonth, lastEndedWeek, monthPeriod, weekPeriod } from "../src/reports/period";
import { renderMonthlyReport, renderWeeklyReport } from "../src/reports/render";

const DAY = 86400000;
const at = (iso: string) => Date.parse(iso);

describe("report periods", () => {
  it("uses the ISO week that contains the anchor, Monday to Monday UTC", () => {
    const week = weekPeriod(at("2026-11-05T08:00:00.000Z"));
    expect(week).toEqual({
      id: "2026-W45",
      from: "2026-11-02T00:00:00.000Z",
      to: "2026-11-09T00:00:00.000Z",
      firstDay: "2026-11-02",
      lastDay: "2026-11-08",
    });
  });

  it("numbers weeks by their ISO year, not by the calendar year of the day", () => {
    // Week 1 of 2026 starts on Monday 2025-12-29 because 1 January 2026 is a Thursday.
    expect(weekPeriod(at("2026-01-01T00:00:00.000Z")).id).toBe("2026-W01");
    expect(weekPeriod(at("2025-12-29T00:00:00.000Z")).firstDay).toBe("2025-12-29");
    // 2021-01-01 belongs to the last week of 2020.
    expect(weekPeriod(at("2021-01-01T00:00:00.000Z")).id).toBe("2020-W53");
    expect(weekPeriod(at("2021-01-01T00:00:00.000Z")).firstDay).toBe("2020-12-28");
    // 2024-12-30 (Monday) opens 2025.
    expect(weekPeriod(at("2024-12-30T00:00:00.000Z")).id).toBe("2025-W01");
    // 2026 has 53 ISO weeks, so its last days still belong to 2026-W53.
    expect(weekPeriod(at("2026-12-31T00:00:00.000Z")).id).toBe("2026-W53");
    expect(weekPeriod(at("2027-01-01T00:00:00.000Z")).id).toBe("2026-W53");
  });

  it("reports the most recently ended week, not the week in progress", () => {
    const week = lastEndedWeek(at("2026-11-05T08:00:00.000Z"));
    expect(week.id).toBe("2026-W44");
    expect(week.firstDay).toBe("2026-10-26");
    expect(week.lastDay).toBe("2026-11-01");
    expect(week.to).toBe("2026-11-02T00:00:00.000Z");
  });

  it("switches period exactly at the Monday boundary", () => {
    const monday = at("2026-11-02T00:00:00.000Z");
    // One millisecond earlier the week in progress is still W44, so W44 is not due yet.
    expect(weekPeriod(monday - 1).id).toBe("2026-W44");
    expect(lastEndedWeek(monday - 1).id).toBe("2026-W43");
    expect(lastEndedWeek(monday).id).toBe("2026-W44");
    expect(weekPeriod(monday).id).toBe("2026-W45");
  });

  it("uses UTC calendar months, including leap February", () => {
    expect(monthPeriod(at("2024-02-15T12:00:00.000Z"))).toEqual({
      id: "2024-02",
      from: "2024-02-01T00:00:00.000Z",
      to: "2024-03-01T00:00:00.000Z",
      firstDay: "2024-02-01",
      lastDay: "2024-02-29",
    });
    expect(monthPeriod(at("2026-12-31T23:59:59.999Z")).to).toBe("2027-01-01T00:00:00.000Z");
  });

  it("reports the most recently ended month, also across a year boundary", () => {
    expect(lastEndedMonth(at("2026-11-05T08:00:00.000Z")).id).toBe("2026-10");
    expect(lastEndedMonth(at("2026-11-05T08:00:00.000Z")).lastDay).toBe("2026-10-31");
    const january = lastEndedMonth(at("2026-01-01T00:00:00.000Z"));
    expect(january.id).toBe("2025-12");
    expect(january.firstDay).toBe("2025-12-01");
    expect(january.to).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an instant that is not a finite number", () => {
    expect(() => weekPeriod(Number.NaN)).toThrow();
    expect(() => monthPeriod(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("keeps every weekly period exactly seven days long", () => {
    const week = weekPeriod(at("2026-11-05T08:00:00.000Z"));
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * DAY);
  });
});

const totals = (overrides: Partial<ReportTotals> = {}): ReportTotals => ({
  sessions: 128,
  turns: 2340,
  tokens: 12_400_000,
  cacheHitRatio: 0.923,
  computedCost: { usd: 41.2, unknown: 3 },
  reportedCost: { usd: null, unknown: 2340 },
  pricing: { basis: "current-reference", observedAt: "2026-10-01" },
  issues: { warning: 2, error: 0, critical: 0 },
  ...overrides,
});

const weekly: WeeklyReportData = {
  id: "2026-W44",
  from: "2026-10-26T00:00:00.000Z",
  to: "2026-11-02T00:00:00.000Z",
  firstDay: "2026-10-26",
  lastDay: "2026-11-01",
  totals: totals(),
  previous: totals({ sessions: 141, tokens: 13_100_000 }),
  agents: [
    { agent: "claude-code", sessions: 90, turns: 1500, tokens: 8_000_000, computedCostUsd: 25.5 },
    { agent: "codex", sessions: 38, turns: 840, tokens: 4_400_000, computedCostUsd: null },
  ],
  days: [
    { date: "2026-10-26", tokens: 1_000_000 },
    { date: "2026-10-27", tokens: 2_500_000 },
  ],
  quotas: [
    {
      subscription: "Claude Pro",
      window: "five_hours",
      usedUsd: 4.2,
      limitUsd: 6.5,
      usedPct: 0.64,
      resetsAt: "2026-11-02T12:00:00.000Z",
      projectedLimitAt: "2026-11-02T15:00:00.000Z",
      deviationPct: 3,
    },
    {
      subscription: "ChatGPT Plus",
      window: "weekly",
      usedUsd: null,
      limitUsd: null,
      usedPct: null,
      resetsAt: null,
      projectedLimitAt: null,
      deviationPct: null,
    },
  ],
  git: {
    attributedTokens: 9_000_000,
    attributedComputedCostUsd: 30.1,
    orphanTokens: 3_400_000,
    orphanComputedCostUsd: 11.1,
    commits: 42,
    pullRequests: 3,
    repositories: 4,
  },
};

const monthly: MonthlyReportData = {
  ...weekly,
  id: "2026-10",
  firstDay: "2026-10-01",
  lastDay: "2026-10-31",
  highlights: {
    busiestDay: { date: "2026-10-14", tokens: 3_200_000 },
    topAgent: { agent: "claude-code", tokens: 8_000_000 },
    topModel: { model: "claude-opus-5", tokens: 5_100_000 },
    cacheReadShare: 0.71,
  },
};

describe("weekly report", () => {
  const markdown = renderWeeklyReport(weekly, "es");

  it("opens with the title and the UTC period in ISO days", () => {
    expect(markdown.startsWith("# Informe semanal · 2026-W44\n")).toBe(true);
    expect(markdown).toContain("2026-10-26 → 2026-11-01");
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("renders every section with its rows", () => {
    for (const section of ["Resumen", "Tokens por agente", "Tokens por día", "Cuotas", "Git"]) {
      expect(markdown).toContain(`## ${section}`);
    }
    expect(markdown).toContain("| Sesiones | 128 | 141 |");
    expect(markdown).toContain("| claude-code | 90 | 1500 |");
    expect(markdown).toContain("| 2026-10-27 |");
    expect(markdown).toContain("| Claude Pro | 5 h |");
    expect(markdown).toContain("Commits: 42");
    expect(markdown).toContain("PRs: 3");
  });

  it("marks unpriced turns and unknown amounts instead of inventing zeros", () => {
    expect(markdown).toContain("(3 sin precio)");
    expect(markdown).toContain("—");
  });

  it("is deterministic: the same data always renders the same bytes", () => {
    expect(renderWeeklyReport(weekly, "es")).toBe(markdown);
    expect(markdown).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it("falls back to a dash when there is no previous period and no activity", () => {
    const empty = renderWeeklyReport({ ...weekly, previous: null, agents: [], days: [] }, "es");
    expect(empty).toContain("| Sesiones | 128 | — |");
    expect(empty).toContain("Sin actividad en el periodo.");
  });

  it("writes the same report in English when the language is en", () => {
    const english = renderWeeklyReport(weekly, "en");
    expect(english.startsWith("# Weekly report · 2026-W44\n")).toBe(true);
    expect(english).toContain("## Summary");
    expect(english).toContain("(3 unpriced)");
    expect(english).not.toBe(markdown);
  });

  it("keeps the numbers in the report language", () => {
    expect(markdown).toContain("12,4");
    expect(renderWeeklyReport(weekly, "en")).toContain("12.4");
  });
});

describe("monthly wrapped report", () => {
  const markdown = renderMonthlyReport(monthly, "es");

  it("uses its own title and the calendar month", () => {
    expect(markdown.startsWith("# Wrapped mensual · 2026-10\n")).toBe(true);
    expect(markdown).toContain("2026-10-01 → 2026-10-31");
  });

  it("adds the highlights of the month", () => {
    expect(markdown).toContain("## Destacados");
    expect(markdown).toContain("2026-10-14");
    expect(markdown).toContain("claude-opus-5");
    expect(markdown).toContain("71,0");
  });

  it("renders in English too", () => {
    expect(renderMonthlyReport(monthly, "en").startsWith("# Monthly wrapped · 2026-10\n")).toBe(
      true,
    );
  });
});

describe("report catalogs", () => {
  const expected = Object.keys(en).sort();

  it("es and en have exactly the same keys", () => {
    expect(Object.keys(es).sort()).toEqual(expected);
  });

  it("no value is empty", () => {
    for (const [key, value] of Object.entries({ ...es, ...en })) {
      expect(typeof value, key).toBe("string");
      expect((value as string).trim(), key).not.toBe("");
    }
  });

  it("both catalogs use the same placeholders", () => {
    const holders = (value: string) =>
      [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const key of expected) {
      expect(holders((es as Record<string, string>)[key] ?? ""), key).toEqual(
        holders((en as Record<string, string>)[key] ?? ""),
      );
    }
  });

  it("every catalog value is defined by the English catalog first", () => {
    expect(expected.every((key) => typeof key === "string")).toBe(true);
  });
});
