/** Report contract (L27): the weekly and monthly markdown reports hold aggregates only. */

/** Known costs only; `unknown` counts the usage turns with no price (never an inferred zero). */
export interface ReportCost {
  usd: number | null;
  unknown: number;
}

export interface ReportTotals {
  sessions: number;
  turns: number;
  /** input + output + cache read + cache write. */
  tokens: number;
  /** cacheRead / (input + cacheRead); null when the period read no input. */
  cacheHitRatio: number | null;
  computedCost: ReportCost;
  reportedCost: ReportCost;
  pricing: {
    basis: string;
    observedAt: string | null;
  };
  issues: { warning: number; error: number; critical: number };
}

export interface ReportAgent {
  agent: string;
  sessions: number;
  turns: number;
  tokens: number;
  computedCostUsd: number | null;
}

export interface ReportQuota {
  subscription: string;
  window: "five_hours" | "weekly" | "monthly";
  usedUsd: number | null;
  limitUsd: number | null;
  /** Share of the limit already used (0..1), null when the limit is unknown. */
  usedPct: number | null;
  resetsAt: string | null;
  projectedLimitAt: string | null;
  /** Calibration deviation in percentage points; null without a calibrated limit. */
  deviationPct: number | null;
}

export interface ReportGit {
  attributedTokens: number;
  attributedComputedCostUsd: number | null;
  orphanTokens: number;
  orphanComputedCostUsd: number | null;
  commits: number;
  pullRequests: number;
  repositories: number;
}

export interface ReportDay {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  tokens: number;
}

export interface WeeklyReportData {
  /** `YYYY-Www` (ISO-8601 week). */
  id: string;
  /** Inclusive start and exclusive end, ISO instants. */
  from: string;
  to: string;
  /** First and last UTC day covered, `YYYY-MM-DD`. */
  firstDay: string;
  lastDay: string;
  totals: ReportTotals;
  /** The immediately preceding period, when it has data. */
  previous: ReportTotals | null;
  agents: ReportAgent[];
  days: ReportDay[];
  quotas: ReportQuota[];
  git: ReportGit;
}

export interface MonthlyHighlights {
  busiestDay: ReportDay | null;
  topAgent: { agent: string; tokens: number } | null;
  topModel: { model: string; tokens: number } | null;
  /** Share of the period tokens served from the cache (0..1). */
  cacheReadShare: number | null;
}

export interface MonthlyReportData extends WeeklyReportData {
  /** `YYYY-MM`. */
  id: string;
  highlights: MonthlyHighlights;
}
