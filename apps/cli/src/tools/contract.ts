/** Aggregate-only GET /api/tools contract (spec §7.1.8, §7.3, phase 5 L3). */
import type { SummaryPeriod } from "../summary/contract";

/** Tokens of the turns that used a tool: overlapping across tools, never summable. */
export interface ToolTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ToolRow {
  /** Canonical tool id from the catalogue in data/ (spec §7.3). */
  tool: string;
  /** Raw names the agents record for this tool, so the mapping can be audited. */
  rawNames: string[];
  /** Per call, from `tool_calls`. */
  calls: number;
  errors: number;
  /** False for an agent that records no tool errors (Codex): the rate is unknown, never 0 (S5). */
  errorStatusKnown: boolean;
  /** Turns that used the tool; they also count in every other tool they used. */
  turns: number;
  /** Turns where the tool was one of two or more distinct canonical tools. */
  sharedTurns: number;
  /** Sum of the known call durations. */
  durationKnownMs: number;
  /** Mean over the calls whose duration is known, unrounded; null when none is known. */
  durationAvgKnownMs: number | null;
  tokens: ToolTokens;
  /** Sums of known costs only; computed cost counts when priced with the current catalog. */
  computedCostUsd: number | null;
  reportedCostUsd: number | null;
  /** Turns that used the tool with a known computed cost, and the rest. */
  costKnownTurns: number;
  costUnknownTurns: number;
}

/** Turn-level pace of one tool on one UTC day: `tool_calls` stores no timestamp (spec §7.3). */
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
  period: SummaryPeriod;
  /** Canonical tools with at least one call in the period, ordered by canonical name. */
  tools: ToolRow[];
  daily: ToolDaily[];
  byAgent: ToolAgentRow[];
}
