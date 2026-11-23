import {
  type Database,
  derivedTaskClassSql,
  TASK_CLASS_SOURCES,
  TASK_CLASSES,
  type TaskClass,
  type TaskClassSource,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN } from "../summary/service";
import type { AgentClassRow, AgentsReport } from "./contract";

function numeric(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe agents");
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) {
    throw new Error("unsafe agents");
  }
  return number;
}

const taskClass = (value: unknown): TaskClass => {
  const found = TASK_CLASSES.find((known) => known === value);
  if (!found) throw new Error("unsafe agents");
  return found;
};
const source = (value: unknown): TaskClassSource => {
  const found = TASK_CLASS_SOURCES.find((known) => known === value);
  if (!found) throw new Error("unsafe agents");
  return found;
};

/**
 * Effective class of every session with a turn in the period: the correction when there is one,
 * otherwise the class derived from its stored evidence (spec §7.3). Evidence is session-wide, not
 * period-scoped: the class is a property of the session, not of the window being looked at.
 */
const SESSION_CLASS = `period AS (
    SELECT t.id, t.session_id FROM turns t
    WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
  ),
  session_class AS (
    SELECT s.id, s.agent,
      coalesce(stc.task_class, ${derivedTaskClassSql("s.id")}) AS task_class,
      CASE WHEN stc.task_class IS NULL THEN 'derived' ELSE 'corrected' END AS source
    FROM sessions s
    JOIN (SELECT DISTINCT session_id FROM period) p ON p.session_id = s.id
    LEFT JOIN session_task_classes stc ON stc.session_id = s.id
  )`;

/** One queue operation: no reads inside an ingestion transaction. Never mutates data. */
export function readAgents(db: Database, period: SummaryPeriod): Promise<AgentsReport> {
  const { hash } = currentPricing();
  return withDatabase(db, async () => {
    const params = [period.from, period.to, hash];
    const rows = await db.all(
      `WITH ${SESSION_CLASS}
      SELECT sc.task_class, sc.source, sc.agent,
        count(DISTINCT t.session_id) AS sessions, count(*) AS turns,
        coalesce(sum(u.input_tokens), 0) AS input,
        coalesce(sum(u.output_tokens), 0) AS output,
        coalesce(sum(u.cache_read_tokens), 0) AS cache_read,
        coalesce(sum(u.cache_write_tokens), 0) AS cache_write,
        coalesce(sum(u.input_tokens::HUGEINT + u.output_tokens::HUGEINT
          + u.cache_read_tokens::HUGEINT + u.cache_write_tokens::HUGEINT), 0) AS total,
        sum(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed,
        count(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed_known,
        sum(u.reported_cost_usd) AS reported,
        count(u.reported_cost_usd) AS reported_known
      FROM turns t
      JOIN session_class sc ON sc.id = t.session_id
      LEFT JOIN usage u ON u.turn_id = t.id
      ${PRICING_CHECKPOINT_JOIN}
      WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
      GROUP BY 1, 2, 3`,
      params,
    );

    const result: AgentClassRow[] = rows.map((row) => {
      const input = numeric(row.input);
      const cacheRead = numeric(row.cache_read);
      const cacheWrite = numeric(row.cache_write);
      const denominator = input + cacheRead + cacheWrite;
      const computedKnown = numeric(row.computed_known);
      return {
        taskClass: taskClass(row.task_class),
        source: source(row.source),
        agent: String(row.agent),
        sessions: numeric(row.sessions),
        turns: numeric(row.turns),
        tokens: {
          input,
          output: numeric(row.output),
          cacheRead,
          cacheWrite,
          total: numeric(row.total),
        },
        computedCostUsd: computedKnown ? numeric(row.computed) : null,
        reportedCostUsd: numeric(row.reported_known) ? numeric(row.reported) : null,
        cacheHitRatio: denominator ? cacheRead / denominator : null,
      };
    });

    // Each session belongs to exactly one row, so the row sums are the session totals.
    const totals = { derivedSessions: 0, correctedSessions: 0 };
    for (const row of result) {
      if (row.source === "corrected") totals.correctedSessions += row.sessions;
      else totals.derivedSessions += row.sessions;
    }
    const order = (row: AgentClassRow) =>
      [
        TASK_CLASSES.indexOf(row.taskClass),
        TASK_CLASS_SOURCES.indexOf(row.source),
        row.agent,
      ] as const;
    result.sort((a, b) => {
      const [classA, sourceA, agentA] = order(a);
      const [classB, sourceB, agentB] = order(b);
      return classA - classB || sourceA - sourceB || agentA.localeCompare(agentB);
    });
    return { period, classes: [...TASK_CLASSES], rows: result, totals };
  });
}
