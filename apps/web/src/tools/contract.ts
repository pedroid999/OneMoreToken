// GET /api/tools response shape (Phase 5 L3). Mirrors apps/cli/src/tools/service.ts: the web app
// cannot import it because the server side pulls in DuckDB through @omt/core.

/** Tokens of the turns that used a tool: overlapping across tools, never summable. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Sums of known costs only; null when none are known. */
interface Costs {
  computedCostUsd: number | null;
  reportedCostUsd: number | null;
}

export interface ToolRow extends Costs {
  /** Canonical tool id from the catalogue in data/ (spec §7.3). */
  tool: string;
  /** Raw names the agents record for this tool, so the mapping can be audited. */
  rawNames: string[];
  /** Per call, from `tool_calls`. */
  calls: number;
  errors: number;
  /** False for an agent that records no tool errors (Codex): the rate is unknown, not 0 (S5). */
  errorStatusKnown: boolean;
  /** Turns that used the tool; they also count in the other tools they used. */
  turns: number;
  /** Turns where the tool was one of two or more. */
  sharedTurns: number;
  durationKnownMs: number;
  durationAvgKnownMs: number | null;
  /** Tokens of the turns that used the tool (see the overlap warning). */
  tokens: TokenTotals;
  costKnownTurns: number;
  costUnknownTurns: number;
}

/** Turn-level pace of one tool on one UTC day (spec §7.3: read from the turn, not the call). */
export interface ToolDaily {
  day: string;
  tool: string;
  tokens: number;
}

/** One raw name seen by one agent, with the canonical tool it resolves to. */
export interface ToolAgentRow {
  agent: string;
  rawName: string;
  tool: string;
  calls: number;
  errors: number;
  errorStatusKnown: boolean;
}

export interface ToolsReport {
  period: { from: string; to: string };
  tools: ToolRow[];
  daily: ToolDaily[];
  byAgent: ToolAgentRow[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const tokenTotals = (value: unknown) => record(value) && typeof value.total === "number";

export const isToolsReport = (value: unknown): value is ToolsReport =>
  record(value) &&
  Array.isArray(value.tools) &&
  Array.isArray(value.daily) &&
  Array.isArray(value.byAgent) &&
  value.tools.every(
    (tool) =>
      record(tool) &&
      typeof tool.tool === "string" &&
      typeof tool.calls === "number" &&
      typeof tool.errors === "number" &&
      typeof tool.errorStatusKnown === "boolean" &&
      tokenTotals(tool.tokens),
  ) &&
  value.daily.every(
    (row) => record(row) && typeof row.day === "string" && typeof row.tool === "string",
  ) &&
  value.byAgent.every(
    (row) =>
      record(row) &&
      typeof row.agent === "string" &&
      typeof row.rawName === "string" &&
      typeof row.tool === "string",
  );
