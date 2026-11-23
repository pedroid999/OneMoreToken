import {
  type Database,
  loadToolCatalogue,
  type SqlParams,
  type ToolCatalogue,
  toolErrorStatusKnown,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN } from "../summary/service";
import { canonicalTools } from "./canonical";
import type { ToolAgentRow, ToolDaily, ToolRow, ToolsReport } from "./contract";

function numeric(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe tools");
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw new Error("unsafe tools");
  }
  return number;
}
const TOKENS = `coalesce(sum(u.input_tokens), 0) AS input,
  coalesce(sum(u.output_tokens), 0) AS output,
  coalesce(sum(u.cache_read_tokens), 0) AS cache_read,
  coalesce(sum(u.cache_write_tokens), 0) AS cache_write,
  coalesce(sum(u.input_tokens::HUGEINT + u.output_tokens::HUGEINT
    + u.cache_read_tokens::HUGEINT + u.cache_write_tokens::HUGEINT), 0) AS total`;

/** One queue operation: no reads inside an ingestion transaction. Never mutates data. */
export function readTools(
  db: Database,
  period: SummaryPeriod,
  options: { catalogue?: ToolCatalogue; cataloguePath?: string } = {},
): Promise<ToolsReport> {
  const catalogue = options.catalogue ?? loadToolCatalogue(options.cataloguePath);
  const { hash } = currentPricing();
  return withDatabase(db, async () => {
    // Per call: `tool_calls` is the only table with calls, errors and durations (S3).
    const params: SqlParams = [period.from, period.to];
    const canon = canonicalTools(catalogue, params);
    const callRows = await db.all(
      `WITH ${canon.cte}
      calls AS (
        SELECT ${canon.of("x.tool")} AS tool, x.tool AS raw_name, s.agent AS agent,
          count(*) AS calls,
          count(CASE WHEN x.status = 'error' THEN 1 END) AS errors,
          count(x.duration_ms) AS duration_calls,
          coalesce(sum(x.duration_ms), 0) AS duration_known_ms
        FROM tool_calls x
        JOIN turns t ON t.id = x.turn_id
        JOIN sessions s ON s.id = t.session_id
        ${canon.join}
        WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
        GROUP BY 1, 2, 3
      )
      SELECT * FROM calls ORDER BY 1, 3, 2`,
      params,
    );

    // Per turn: tokens and costs of the turns that used the tool, overlapping across tools.
    const turnParams: SqlParams = [period.from, period.to, hash];
    const turnCanon = canonicalTools(catalogue, turnParams);
    const toolTurns = `tool_turns AS (
      SELECT DISTINCT ${turnCanon.of("x.tool")} AS tool, x.turn_id AS turn_id
      FROM tool_calls x ${turnCanon.join}
    ),
    shared AS (SELECT turn_id, count(*) AS tools_in_turn FROM tool_turns GROUP BY 1)`;
    const turnRows = await db.all(
      `WITH ${turnCanon.cte} ${toolTurns}
      SELECT tt.tool, count(*) AS turns,
        count(CASE WHEN sh.tools_in_turn >= 2 THEN 1 END) AS shared_turns,
        ${TOKENS},
        sum(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed,
        count(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed_known,
        sum(u.reported_cost_usd) AS reported,
        count(u.reported_cost_usd) AS reported_known
      FROM tool_turns tt
      JOIN turns t ON t.id = tt.turn_id
      JOIN shared sh ON sh.turn_id = tt.turn_id
      LEFT JOIN usage u ON u.turn_id = t.id
      ${PRICING_CHECKPOINT_JOIN}
      WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
      GROUP BY 1
      ORDER BY 1`,
      turnParams,
    );
    const perTurn = new Map(turnRows.map((row) => [String(row.tool), row]));

    const dailyParams: SqlParams = [period.from, period.to];
    const dailyCanon = canonicalTools(catalogue, dailyParams);
    const dailyRows = await db.all(
      `WITH ${dailyCanon.cte} tool_turns AS (
        SELECT DISTINCT ${dailyCanon.of("x.tool")} AS tool, x.turn_id AS turn_id
        FROM tool_calls x ${dailyCanon.join}
      )
      SELECT strftime(t.ts AT TIME ZONE 'UTC', '%Y-%m-%d') AS day, tt.tool,
        coalesce(sum(u.input_tokens::HUGEINT + u.output_tokens::HUGEINT
          + u.cache_read_tokens::HUGEINT + u.cache_write_tokens::HUGEINT), 0) AS tokens
      FROM tool_turns tt
      JOIN turns t ON t.id = tt.turn_id
      LEFT JOIN usage u ON u.turn_id = t.id
      WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
      GROUP BY 1, 2
      ORDER BY 1, 2`,
      dailyParams,
    );

    // Calls, raw names and error status per canonical tool, plus the auditable raw-name table.
    const byTool = new Map<
      string,
      {
        calls: number;
        errors: number;
        durationKnownMs: number;
        durationCalls: number;
        known: boolean;
      }
    >();
    const byAgent: ToolAgentRow[] = [];
    for (const row of callRows) {
      const tool = String(row.tool);
      const rawName = String(row.raw_name);
      const agent = String(row.agent);
      const calls = numeric(row.calls);
      const errors = numeric(row.errors);
      const known = toolErrorStatusKnown(agent);
      const entry = byTool.get(tool) ?? {
        calls: 0,
        errors: 0,
        durationKnownMs: 0,
        durationCalls: 0,
        known: true,
      };
      entry.calls += calls;
      entry.errors += errors;
      entry.durationKnownMs += numeric(row.duration_known_ms);
      entry.durationCalls += numeric(row.duration_calls);
      // A tool used by any agent without error status reports it as unknown, never as zero.
      entry.known = entry.known && known;
      byTool.set(tool, entry);
      byAgent.push({ agent, rawName, tool, calls, errors, errorStatusKnown: known });
    }

    const rawNames = new Map<string, string[]>();
    for (const row of byAgent) {
      const names = rawNames.get(row.tool) ?? [];
      if (!names.includes(row.rawName)) names.push(row.rawName);
      rawNames.set(row.tool, names);
    }

    const tools: ToolRow[] = [...byTool.keys()].sort().map((tool) => {
      const calls = byTool.get(tool);
      const turns = perTurn.get(tool);
      const known = numeric(turns?.computed_known);
      const turnCount = numeric(turns?.turns);
      return {
        tool,
        rawNames: (rawNames.get(tool) ?? []).sort(),
        calls: calls?.calls ?? 0,
        errors: calls?.errors ?? 0,
        errorStatusKnown: calls?.known ?? false,
        turns: turnCount,
        sharedTurns: numeric(turns?.shared_turns),
        durationKnownMs: calls?.durationKnownMs ?? 0,
        durationAvgKnownMs: calls?.durationCalls
          ? (calls.durationKnownMs ?? 0) / calls.durationCalls
          : null,
        tokens: {
          input: numeric(turns?.input),
          output: numeric(turns?.output),
          cacheRead: numeric(turns?.cache_read),
          cacheWrite: numeric(turns?.cache_write),
          total: numeric(turns?.total),
        },
        computedCostUsd: known ? numeric(turns?.computed) : null,
        reportedCostUsd: numeric(turns?.reported_known) ? numeric(turns?.reported) : null,
        costKnownTurns: known,
        costUnknownTurns: turnCount - known,
      };
    });

    const daily: ToolDaily[] = dailyRows.map((row) => ({
      day: String(row.day),
      tool: String(row.tool),
      tokens: numeric(row.tokens),
    }));
    return { period, tools, daily, byAgent };
  });
}
