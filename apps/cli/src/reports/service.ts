import {
  type Database,
  lastEndedMonth,
  lastEndedWeek,
  type MonthlyReportData,
  type PricingFile,
  type ReportAgent,
  type ReportDay,
  type ReportGit,
  type ReportLanguage,
  type ReportPeriod,
  type ReportQuota,
  type ReportTotals,
  renderMonthlyReport,
  renderWeeklyReport,
  type WeeklyReportData,
  weekPeriod,
} from "@omt/core";
import { allowedWindowsFor } from "../calibrations/allowed";
import { createCalibrationStore } from "../calibrations/store";
import { withDatabase } from "../db-queue";
import type { GitReport } from "../git/service";
import { readGit } from "../git/service";
import { type Quotas, readQuotas } from "../quotas/service";
import type { Summary } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN, readSummary } from "../summary/service";
import { writeReportFile } from "./store";

const DAY = 86_400_000;

export interface ReportsOptions {
  /** D4 destination: `${XDG_DATA_HOME:-~/.local/share}/one-more-token/reports`. */
  directory: string;
  /** The user's subscriptions file: quotas and calibrations. */
  configPath: string;
  /** Manual quota readings; a corrupt file degrades to quotas without readings. */
  calibrationsPath: string;
  language: ReportLanguage;
  /** Clock: each pass resolves the periods again, so the reports always move forward. */
  now: () => number;
  /** Test seam: the pricing catalog; production reads `data/pricing.json`. */
  pricing?: PricingFile;
}

export interface GeneratedReport {
  kind: "weekly" | "monthly";
  id: string;
  path: string;
  written: boolean;
}

function count(value: unknown): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) throw new Error("unsafe report");
  return number;
}

function optional(value: unknown): number | null {
  return value === null || value === undefined ? null : count(value);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumKnown(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : sum(known);
}

function totalsOf(summary: Summary): ReportTotals {
  const base = summary.tokens.input + summary.tokens.cacheRead;
  return {
    sessions: summary.sessions,
    turns: summary.turns,
    tokens: summary.tokens.total,
    cacheHitRatio: base > 0 ? summary.tokens.cacheRead / base : null,
    computedCost: { usd: summary.costs.computed.usd, unknown: summary.costs.computed.unknown },
    reportedCost: { usd: summary.costs.reported.usd, unknown: summary.costs.reported.unknown },
    pricing: { basis: summary.pricing.basis, observedAt: summary.pricing.observedAt },
    issues: summary.issues,
  };
}

const TOKENS_SUM = `coalesce(sum(u.input_tokens::HUGEINT + u.output_tokens::HUGEINT
  + u.cache_read_tokens::HUGEINT + u.cache_write_tokens::HUGEINT), 0)`;
const PERIOD_FILTER = "t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ";
const JOINED_TURNS = `FROM turns t
  LEFT JOIN usage u ON u.turn_id = t.id
  ${PRICING_CHECKPOINT_JOIN}
  WHERE ${PERIOD_FILTER}`;

/** Tokens and computed cost per agent in the period, heaviest first. */
async function agentRows(
  db: Database,
  period: ReportPeriod,
  pricing?: PricingFile,
): Promise<ReportAgent[]> {
  const { hash } = currentPricing(pricing);
  const rows = await withDatabase(db, () =>
    db.all(
      `SELECT s.agent AS agent, count(DISTINCT t.session_id) AS sessions, count(*) AS turns,
      ${TOKENS_SUM} AS tokens,
      sum(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed
      ${JOINED_TURNS} GROUP BY 1 ORDER BY tokens DESC, agent`,
      [period.from, period.to, hash],
    ),
  );
  return rows.map((row) => ({
    agent: String(row.agent),
    sessions: count(row.sessions),
    turns: count(row.turns),
    tokens: count(row.tokens),
    computedCostUsd: optional(row.computed),
  }));
}

/** The heaviest model of the period, for the monthly highlights. */
async function topModelRow(
  db: Database,
  period: ReportPeriod,
): Promise<{ model: string; tokens: number } | null> {
  const [row] = await withDatabase(db, () =>
    db.all(
      `SELECT t.model AS model, ${TOKENS_SUM} AS tokens
      ${JOINED_TURNS} AND t.model IS NOT NULL GROUP BY 1 ORDER BY tokens DESC, model LIMIT 1`,
      [period.from, period.to],
    ),
  );
  if (!row?.model) return null;
  return { model: String(row.model), tokens: count(row.tokens) };
}

function gitOf(report: GitReport): ReportGit {
  return {
    attributedTokens: sum(report.commits.map((commit) => commit.tokens)),
    attributedComputedCostUsd: sumKnown(report.commits.map((commit) => commit.computedCostUsd)),
    orphanTokens: sum(report.orphanSessions.map((session) => session.tokens)),
    orphanComputedCostUsd: sumKnown(
      report.orphanSessions.map((session) => session.computedCostUsd),
    ),
    commits: report.commits.length,
    pullRequests: report.pullRequests.length,
    repositories: new Set(report.commits.map((commit) => commit.repo)).size,
  };
}

/** One row per subscription window: the current window, its limit and its calibration accuracy. */
function quotaRows(quotas: Quotas): ReportQuota[] {
  const rows: ReportQuota[] = [];
  for (const subscription of quotas.subscriptions) {
    for (const window of subscription.windows) {
      // A report covers a closed period, so "current" is usually outside it: show the last window
      // that actually ran inside the period the report describes.
      const shown = window.windows[window.windows.length - 1] ?? window.current;
      const pct = shown?.estimatedPct ?? null;
      rows.push({
        subscription: subscription.label,
        window: window.kind,
        usedUsd: shown?.usedUsd ?? null,
        limitUsd: window.limitUsd,
        usedPct: pct === null ? null : pct / 100,
        resetsAt: shown?.endsAt ?? window.resetsAt,
        projectedLimitAt: window.projection?.projectedLimitAt ?? null,
        deviationPct: window.calibration.meanAbsoluteDeviationPct,
      });
    }
  }
  return rows;
}

async function quotaRowsOf(
  db: Database,
  period: ReportPeriod,
  options: ReportsOptions,
): Promise<ReportQuota[]> {
  // Same rule as the API: which window kinds a subscription may calibrate.
  const calibrations = createCalibrationStore(
    options.calibrationsPath,
    allowedWindowsFor(options.configPath),
  );
  const readings = await calibrations.list().catch(() => null);
  // As of the end of the period: a closed report must not depend on when the pass ran (L27(4)).
  const quotas = await readQuotas(db, {
    period,
    configPath: options.configPath,
    calibrations: readings,
    now: Date.parse(period.to),
  });
  return quotaRows(quotas);
}

/** Everything both report kinds need for one period, plus the previous period for comparison. */
interface PeriodData {
  summary: Summary;
  totals: ReportTotals;
  previous: ReportTotals | null;
  agents: ReportAgent[];
  days: ReportDay[];
  quotas: ReportQuota[];
  git: ReportGit;
}

async function periodData(
  db: Database,
  period: ReportPeriod,
  previousPeriod: ReportPeriod,
  options: ReportsOptions,
): Promise<PeriodData> {
  const [summary, previousSummary, agents, quotas, git] = await Promise.all([
    readSummary(db, period, options.pricing),
    readSummary(db, previousPeriod, options.pricing),
    agentRows(db, period, options.pricing),
    quotaRowsOf(db, period, options),
    readGit(db, period),
  ]);
  const hasPrevious = previousSummary.turns > 0;
  return {
    summary,
    totals: totalsOf(summary),
    previous: hasPrevious ? totalsOf(previousSummary) : null,
    agents,
    days: summary.days,
    quotas,
    git: gitOf(git),
  };
}

async function weeklyData(
  db: Database,
  period: ReportPeriod & { id: string; firstDay: string; lastDay: string },
  options: ReportsOptions,
): Promise<WeeklyReportData> {
  const data = await periodData(db, period, weekPeriod(Date.parse(period.from) - DAY), options);
  return { ...period, ...data };
}

async function monthlyData(
  db: Database,
  period: ReportPeriod & { id: string; firstDay: string; lastDay: string },
  options: ReportsOptions,
): Promise<MonthlyReportData> {
  const [data, topModel] = await Promise.all([
    periodData(db, period, monthPeriodBefore(period), options),
    topModelRow(db, period),
  ]);
  const busiest = data.days.reduce<ReportDay | null>(
    (best, day) => (best === null || day.tokens > best.tokens ? day : best),
    null,
  );
  const { summary, ...rest } = data;
  return {
    ...period,
    ...rest,
    highlights: {
      busiestDay: busiest && busiest.tokens > 0 ? busiest : null,
      topAgent: data.agents[0]
        ? { agent: data.agents[0].agent, tokens: data.agents[0].tokens }
        : null,
      topModel,
      cacheReadShare:
        summary.tokens.total > 0 ? summary.tokens.cacheRead / summary.tokens.total : null,
    },
  };
}

function monthPeriodBefore(period: ReportPeriod): ReportPeriod {
  const start = Date.parse(period.from);
  const date = new Date(start);
  const previous = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
  return { from: new Date(previous).toISOString(), to: period.from };
}

/**
 * Generates the weekly and monthly reports of the periods that ended most recently (L27): one
 * private markdown file each, in the chosen language, and no write when the content is unchanged.
 */
export async function generateReports(
  db: Database,
  options: ReportsOptions,
): Promise<GeneratedReport[]> {
  const now = options.now();
  const week = lastEndedWeek(now);
  const month = lastEndedMonth(now);

  const weekly = await weeklyData(db, week, options);
  const monthly = await monthlyData(db, month, options);

  return [
    {
      kind: "weekly",
      id: week.id,
      ...(await writeReportFile(
        options.directory,
        `weekly-${week.id}.md`,
        renderWeeklyReport(weekly, options.language),
      )),
    },
    {
      kind: "monthly",
      id: month.id,
      ...(await writeReportFile(
        options.directory,
        `monthly-${month.id}.md`,
        renderMonthlyReport(monthly, options.language),
      )),
    },
  ];
}
