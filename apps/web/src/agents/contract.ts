// GET /api/agents response shape (Phase 5 L3). Mirrors apps/cli/src/agents/service.ts: the web app
// cannot import it because the server side pulls in DuckDB through @omt/core.
import type { TaskClassSource, TaskClassValue } from "../session/taskClass";

export type { TaskClassSource, TaskClassValue };

/** Tokens of the turns of the row. */
export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** One row per (task class, source, agent): derived and corrected sessions stay apart (S2). */
export interface AgentClassRow {
  taskClass: TaskClassValue;
  source: TaskClassSource;
  agent: string;
  sessions: number;
  turns: number;
  tokens: AgentTokens;
  /** Sums of known costs only; null when none are known. */
  computedCostUsd: number | null;
  reportedCostUsd: number | null;
  cacheHitRatio: number | null;
}

export interface AgentsReport {
  period: { from: string; to: string };
  /** Display order of the task classes. */
  classes: TaskClassValue[];
  rows: AgentClassRow[];
  totals: { derivedSessions: number; correctedSessions: number };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isAgentsReport = (value: unknown): value is AgentsReport =>
  record(value) &&
  Array.isArray(value.classes) &&
  Array.isArray(value.rows) &&
  record(value.totals) &&
  typeof value.totals.derivedSessions === "number" &&
  typeof value.totals.correctedSessions === "number" &&
  value.rows.every(
    (row) =>
      record(row) &&
      typeof row.taskClass === "string" &&
      typeof row.source === "string" &&
      typeof row.agent === "string" &&
      typeof row.sessions === "number" &&
      typeof row.turns === "number" &&
      record(row.tokens) &&
      typeof row.tokens.total === "number",
  );
