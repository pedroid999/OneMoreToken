import {
  type Database,
  type ExplorerDimension,
  type ExplorerFilter,
  type ExplorerQuery,
  ExplorerQuerySchema,
  hashContent,
  loadPricing,
  type PricingFile,
  PricingFileSchema,
  type SqlParams,
  TURN_ROLE_SQL,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { summaryPeriod } from "../summary/service";
import type { ExplorerColumn, ExplorerResponse, ExplorerValue } from "./contract";

export const DEFAULT_EXPLORER_LIMIT = 1000;

export interface ExplorerRequest {
  query: ExplorerQuery;
  period: SummaryPeriod;
}

/** Strict body validation; bounds follow the Summary period rules exactly. */
export function parseExplorerQuery(input: unknown): ExplorerRequest | null {
  const parsed = ExplorerQuerySchema.safeParse(input);
  if (!parsed.success) return null;
  const { from, to } = parsed.data;
  const period = summaryPeriod(new URLSearchParams({ from, to }));
  return period ? { query: parsed.data, period } : null;
}

const UTC = "b.ts AT TIME ZONE 'UTC'";
/** Fixed SQL per dimension: the only expressions ever placed in a query (L16). */
const DIMENSION_SQL: Record<ExplorerDimension, string> = {
  agent: "b.agent",
  model: "b.model",
  provider: "b.provider",
  subscription: "b.subscription",
  profile: "b.profile",
  attribution: "b.attribution",
  role: "b.role",
  effort: "b.effort",
  repo: "b.repo",
  branch: "b.branch",
  tool: "tc.tool",
  day: `strftime(${UTC}, '%Y-%m-%d')`,
  hourOfDay: `CAST(hour(${UTC}) AS INTEGER)`,
  dayOfWeek: `CAST(isodow(${UTC}) AS INTEGER)`,
};

function numeric(value: unknown, integer = true): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe explorer");
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error("unsafe explorer");
  }
  return number;
}

function dimensionValue(value: unknown): ExplorerValue {
  if (value === null || typeof value === "string") return value;
  return numeric(value);
}

/** Values are always bound; filters on tool select turns (EXISTS) unless tool is grouped. */
function filterSql(filter: ExplorerFilter, groupedByTool: boolean, params: SqlParams): string {
  const placeholders = filter.values.map((value) => {
    params.push(value);
    return `$${params.length}`;
  });
  const list = `(${placeholders.join(", ")})`;
  if (filter.dimension === "tool" && !groupedByTool) {
    const exists = `EXISTS (SELECT 1 FROM tool_calls x WHERE x.turn_id = b.turn_id AND x.tool IN ${list})`;
    return filter.op === "in" ? exists : `NOT ${exists}`;
  }
  const expression = DIMENSION_SQL[filter.dimension];
  return filter.op === "in"
    ? `CAST(${expression} AS VARCHAR) IN ${list}`
    : `(${expression} IS NULL OR CAST(${expression} AS VARCHAR) NOT IN ${list})`;
}

/** One queue operation: no reads inside an ingestion transaction. Never mutates data. */
export function readExplorer(
  db: Database,
  { query, period }: ExplorerRequest,
  pricing?: PricingFile,
): Promise<ExplorerResponse> {
  return withDatabase(db, async () => {
    const catalog = PricingFileSchema.parse(pricing ?? loadPricing());
    const params: SqlParams = [period.from, period.to, hashContent(JSON.stringify(catalog))];
    const groupedByTool = query.dimensions.includes("tool");
    const where = query.filters.map((filter) => filterSql(filter, groupedByTool, params));
    const dimensions = query.dimensions.map((d, i) => `${DIMENSION_SQL[d]} AS d${i},`);
    const positions = query.dimensions.map((_, i) => `${i + 1}`);
    const limit = query.limit ?? DEFAULT_EXPLORER_LIMIT;
    // Attribution joins (L10) only when a dimension or filter needs them; each is one row per turn.
    const used = new Set([...query.dimensions, ...query.filters.map((f) => f.dimension)]);
    const bySubscription = used.has("subscription");
    const byProfile = used.has("profile") || used.has("attribution");
    const byRole = used.has("role");
    // Computed cost counts only when priced with the current catalog, as in the Summary.
    const rows = await db.all(
      `WITH b AS (
        SELECT t.id AS turn_id, t.session_id, t.ts, t.model, t.provider, t.effort,
          s.agent, s.repo, s.branch, u.turn_id IS NOT NULL AS has_usage,
          u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
          u.reported_cost_usd,
          CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END AS computed_cost_usd,
          ${bySubscription ? "a.subscription_id" : "NULL"} AS subscription,
          ${byProfile ? "pp.name" : "NULL"} AS profile,
          ${byProfile ? "tp.attribution" : "NULL"} AS attribution,
          ${byRole ? TURN_ROLE_SQL : "NULL"} AS role
        FROM turns t LEFT JOIN usage u ON u.turn_id = t.id
        LEFT JOIN sessions s ON s.id = t.session_id
        LEFT JOIN ingest_checkpoints c ON c.source_id = s.source_id
        ${bySubscription ? "LEFT JOIN turn_subscriptions a ON a.turn_id = t.id" : ""}
        ${byProfile ? "LEFT JOIN turn_profile tp ON tp.turn_id = t.id LEFT JOIN profiles pp ON pp.hash = tp.profile_hash" : ""}
        ${byRole ? "LEFT JOIN subagent_runs r ON r.id = s.id" : ""}
        WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
      )
      SELECT ${dimensions.join(" ")}
        coalesce(sum(b.input_tokens), 0) AS input,
        coalesce(sum(b.output_tokens), 0) AS output,
        coalesce(sum(b.cache_read_tokens), 0) AS cache_read,
        coalesce(sum(b.cache_write_tokens), 0) AS cache_write,
        coalesce(sum(b.input_tokens::HUGEINT + b.output_tokens::HUGEINT
          + b.cache_read_tokens::HUGEINT + b.cache_write_tokens::HUGEINT), 0) AS total,
        sum(b.computed_cost_usd) AS computed, count(b.computed_cost_usd) AS computed_known,
        sum(b.reported_cost_usd) AS reported, count(b.reported_cost_usd) AS reported_known,
        count(CASE WHEN b.has_usage THEN 1 END) AS usage_turns,
        count(*) AS turns, count(DISTINCT b.session_id) AS sessions
      FROM b
      ${groupedByTool ? "LEFT JOIN (SELECT DISTINCT turn_id, tool FROM tool_calls) tc ON tc.turn_id = b.turn_id" : ""}
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ${positions.length ? `GROUP BY ${positions.join(", ")}` : ""}
      ${positions.length ? `ORDER BY ${positions.map((p) => `${p} ASC NULLS LAST`).join(", ")}` : ""}
      LIMIT ${limit + 1}`,
      params,
    );

    const costs = query.metrics.filter((m) => m === "computedCost" || m === "reportedCost");
    const columns: ExplorerColumn[] = [
      ...query.dimensions.map((name) => ({ name, type: "dimension" as const })),
      ...query.metrics.map((name) => ({ name, type: "metric" as const })),
      ...costs.flatMap((name) => [
        { name: `${name}Known`, type: "coverage" as const },
        { name: `${name}Unknown`, type: "coverage" as const },
      ]),
    ];
    const result = rows.slice(0, limit).map((row) => {
      const input = numeric(row.input);
      const cacheRead = numeric(row.cache_read);
      const cacheWrite = numeric(row.cache_write);
      const usageTurns = numeric(row.usage_turns);
      const denominator = numeric(input + cacheRead + cacheWrite);
      const known = {
        computed: numeric(row.computed_known),
        reported: numeric(row.reported_known),
      };
      const metric = {
        input,
        output: numeric(row.output),
        cacheRead,
        cacheWrite,
        total: numeric(row.total),
        computedCost: known.computed ? numeric(row.computed, false) : null,
        reportedCost: known.reported ? numeric(row.reported, false) : null,
        cacheHitRatio: denominator ? cacheRead / denominator : null,
        turns: numeric(row.turns),
        sessions: numeric(row.sessions),
      };
      const out: Record<string, ExplorerValue> = {};
      query.dimensions.forEach((name, i) => {
        out[name] = dimensionValue(row[`d${i}`]);
      });
      for (const name of query.metrics) out[name] = metric[name];
      for (const name of costs) {
        const count = name === "computedCost" ? known.computed : known.reported;
        out[`${name}Known`] = count;
        out[`${name}Unknown`] = numeric(usageTurns - count);
      }
      return out;
    });
    return {
      columns,
      rows: result,
      overlapping: groupedByTool,
      truncated: rows.length > limit,
    };
  });
}
