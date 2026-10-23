/** Metrics-only GET /api/sessions and GET /api/sessions/:id contracts (spec §7.1, L21). See README. */
import type { CostCoverage, SummaryPeriod } from "../summary/contract";

export interface SessionTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
export interface SessionStats {
  /** All turns, including user turns. */
  turns: number;
  usageTurns: number;
  tokens: SessionTokens;
  /** Known-only sums, as in the Summary: computed cost needs the current pricing catalog. */
  costs: { reported: CostCoverage; computed: CostCoverage };
}
export interface SessionItem extends SessionStats {
  id: string;
  agent: string;
  /** Last path segment of the working directory; the full path is never returned. */
  cwd: string | null;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  parentId: string | null;
  compactions: number;
  /** Stored sessions whose parent is this one, whatever their period. */
  children: number;
}
export interface SessionPricing {
  basis: "current-reference" | "historical";
  observedAt: string | null;
}
export interface SessionList {
  period: SummaryPeriod;
  /** Stats cover only the turns inside the period. Newest started first. */
  sessions: SessionItem[];
  /** True when more sessions exist than `limit`. */
  truncated: boolean;
  pricing: SessionPricing;
}
export interface SessionToolCall {
  tool: string;
  status: "ok" | "error";
  durationMs: number | null;
}
export interface SessionTurn {
  idx: number;
  role: string;
  ts: string;
  model: string | null;
  provider: string | null;
  effort: string | null;
  isCompaction: boolean;
  /** Null when the turn has no usage row. */
  tokens: Omit<SessionTokens, "total"> | null;
  /** input + cache read + cache write: the prompt the model received; null without usage. */
  contextTokens: number | null;
  costs: { reported: number | null; computed: number | null };
  tools: SessionToolCall[];
}
export interface SessionChild extends SessionStats {
  id: string;
  agent: string;
  startedAt: string;
}
export interface SessionDetail {
  /** Stats cover every turn of the session. */
  session: SessionItem;
  /** Ordered by idx. */
  turns: SessionTurn[];
  /** `agent` is null when the parent session was never ingested. */
  parent: { id: string; agent: string | null } | null;
  children: SessionChild[];
  pricing: SessionPricing;
}
