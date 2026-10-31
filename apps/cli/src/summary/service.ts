import {
  type Database,
  hashContent,
  loadPricing,
  type PricingFile,
  PricingFileSchema,
  TurnSchema,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { CostCoverage, Summary, SummaryPeriod } from "./contract";

const DAY = 86400000;
const utcDay = (ms: number) => Math.floor(ms / DAY) * DAY;

/** Both bounds or neither. Millisecond precision avoids silently truncating finer timestamps. */
export function summaryPeriod(params: URLSearchParams, now = Date.now()): SummaryPeriod | null {
  const froms = params.getAll("from");
  const tos = params.getAll("to");
  let start = now - 7 * DAY;
  let end = now;
  if (froms.length || tos.length) {
    if (froms.length !== 1 || tos.length !== 1) return null;
    const parse = (value: string | undefined) => {
      if (!value || !TurnSchema.shape.ts.safeParse(value).success) return NaN;
      if (/\.\d{4,}/.test(value)) return NaN;
      return Date.parse(value);
    };
    start = parse(froms[0]);
    end = parse(tos[0]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  if ((utcDay(end - 1) - utcDay(start)) / DAY + 1 > 366) return null;
  // Keep the UTC wire representation within four-digit ISO years.
  const from = new Date(start).toISOString();
  const to = new Date(end).toISOString();
  if (from.length !== 24 || to.length !== 24) return null;
  return { from, to };
}

/** Joins a turn `t` to its source checkpoint `c`; both to primary keys, so no fanout. */
export const PRICING_CHECKPOINT_JOIN = `LEFT JOIN sessions s ON s.id = t.session_id
      LEFT JOIN ingest_checkpoints c ON c.source_id = s.source_id`;

/**
 * The catalog in force and its hash. Computed cost only counts when the source checkpoint was priced
 * with this hash (`c.pricing_hash = hash`); other rows are stale until reingested.
 */
export function currentPricing(pricing?: PricingFile): { catalog: PricingFile; hash: string } {
  const catalog = PricingFileSchema.parse(pricing ?? loadPricing());
  return { catalog, hash: hashContent(JSON.stringify(catalog)) };
}

function numeric(value: unknown, integer = true): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe summary");
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error("unsafe summary");
  }
  return number;
}

/** One queue operation covers all queries: no reads inside an ingestion transaction. */
export function readSummary(
  db: Database,
  period: SummaryPeriod,
  pricing?: PricingFile,
): Promise<Summary> {
  return withDatabase(db, async () => {
    const { catalog, hash: catalogHash } = currentPricing(pricing);
    const params = [period.from, period.to];
    const selected = `FROM turns t LEFT JOIN usage u ON u.turn_id = t.id
      ${PRICING_CHECKPOINT_JOIN}
      WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ`;
    const [row] = await db.all(
      `SELECT count(DISTINCT t.session_id) AS sessions,
      count(*) AS turns, count(u.turn_id) AS usage_turns,
      coalesce(sum(input_tokens), 0) AS input, coalesce(sum(output_tokens), 0) AS output,
      coalesce(sum(cache_read_tokens), 0) AS cache_read,
      coalesce(sum(cache_write_tokens), 0) AS cache_write,
      sum(reported_cost_usd) AS reported, count(reported_cost_usd) AS reported_known,
      sum(CASE WHEN c.pricing_hash = $3 THEN computed_cost_usd END) AS computed,
      count(CASE WHEN c.pricing_hash = $3 THEN computed_cost_usd END) AS computed_known,
      count(CASE WHEN u.turn_id IS NOT NULL AND c.pricing_hash IS DISTINCT FROM $3 THEN 1 END) AS stale
      ${selected}`,
      [...params, catalogHash],
    );
    if (!row) throw new Error("missing summary");
    const usageTurns = numeric(row.usage_turns);
    const tokens = {
      input: numeric(row.input),
      output: numeric(row.output),
      cacheRead: numeric(row.cache_read),
      cacheWrite: numeric(row.cache_write),
      total: 0,
    };
    tokens.total = numeric(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite);
    const cost = (key: "reported" | "computed"): CostCoverage => {
      const known = numeric(row[`${key}_known`]);
      return {
        usd: known ? numeric(row[key], false) : null,
        known,
        unknown: numeric(usageTurns - known),
      };
    };
    const daily = await db.all(
      `SELECT strftime(t.ts AT TIME ZONE 'UTC', '%Y-%m-%d') AS date,
      coalesce(sum(input_tokens::HUGEINT + output_tokens::HUGEINT + cache_read_tokens::HUGEINT + cache_write_tokens::HUGEINT), 0) AS tokens
      ${selected} GROUP BY 1 ORDER BY 1`,
      params,
    );
    const byDate = new Map(daily.map((day) => [String(day.date), numeric(day.tokens)]));
    const days: Summary["days"] = [];
    for (let ms = utcDay(Date.parse(period.from)); ms < Date.parse(period.to); ms += DAY) {
      const date = new Date(ms).toISOString().slice(0, 10);
      days.push({ date, tokens: byDate.get(date) ?? 0 });
    }
    const issues: Summary["issues"] = { warning: 0, error: 0, critical: 0 };
    for (const issue of await db.all(
      "SELECT severity, count(*) AS count FROM ingest_issues GROUP BY severity",
    )) {
      if (
        issue.severity === "warning" ||
        issue.severity === "error" ||
        issue.severity === "critical"
      ) {
        issues[issue.severity] = numeric(issue.count);
      }
    }
    return {
      period,
      sessions: numeric(row.sessions),
      turns: numeric(row.turns),
      usageTurns,
      tokens,
      costs: { reported: cost("reported"), computed: cost("computed") },
      pricing: {
        basis: catalog.basis ?? "historical",
        observedAt: catalog.observedAt ?? null,
        staleUsageTurns: numeric(row.stale),
      },
      days,
      issues,
      quota: { status: "unavailable" },
    };
  });
}
