/** Aggregate-only GET /api/agents contract (spec §7.1.6, §7.3, phase 5 L3). */

import type { SessionTaskClassSource, SessionTaskClassValue } from "../sessions/contract";
import type { SummaryPeriod } from "../summary/contract";

export interface AgentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** One row per (task class, source, agent): derived and corrected sessions stay apart (S2). */
export interface AgentClassRow {
  taskClass: SessionTaskClassValue;
  source: SessionTaskClassSource;
  agent: string;
  sessions: number;
  turns: number;
  tokens: AgentTokens;
  /** Sums of known costs only; computed cost counts when priced with the current catalog. */
  computedCostUsd: number | null;
  reportedCostUsd: number | null;
  /** Cache read over input + cache read + cache write; null without tokens, never 0. */
  cacheHitRatio: number | null;
}

export interface AgentsReport {
  period: SummaryPeriod;
  /** Display order of the task classes (spec §7.3). */
  classes: SessionTaskClassValue[];
  rows: AgentClassRow[];
  totals: { derivedSessions: number; correctedSessions: number };
}
