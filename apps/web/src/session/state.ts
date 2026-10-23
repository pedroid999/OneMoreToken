// Pure Session view state: URL parsing, API requests, context curve and tools summary
// (spec §7.1, §8.1; L21). No React, no fetch: every rule is unit-tested.
import type { SessionTurn } from "../../../cli/src/sessions/contract";

const DAY = 86_400_000;

/** Agents accepted by GET /api/sessions; mirrors the ingest agents. */
export const SESSION_AGENTS = ["claude-code", "gentle-shell", "pi", "opencode"] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
/** Stored record ids: `<sha256>:session:<sha256>`, as validated by the API. */
const SESSION_ID = /^[0-9a-f]{64}:session:[0-9a-f]{64}$/;

export interface SessionState {
  /** ISO bounds of the half-open [from, to) list period. */
  from: string;
  to: string;
  agent?: SessionAgent | undefined;
  /** Selected session; the detail is shown when present. */
  id?: string | undefined;
}

const isAgent = (value: string | null): value is SessionAgent =>
  (SESSION_AGENTS as readonly (string | null)[]).includes(value);

/** Explicit from/to are kept as written (the API validates them), like the Summary. */
export function parseSessionState(search: string, anchor: number): SessionState {
  const params = new URLSearchParams(search);
  const explicit = params.has("from") || params.has("to");
  const state: SessionState = {
    from: explicit ? (params.get("from") ?? "") : new Date(anchor - 7 * DAY).toISOString(),
    to: explicit ? (params.get("to") ?? "") : new Date(anchor).toISOString(),
  };
  const agent = params.get("agent");
  if (isAgent(agent)) state.agent = agent;
  const id = params.get("id");
  if (id) state.id = id;
  return state;
}

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

/** Only period and agent drive the list request; other URL state never refetches (S11). */
export function listRequest(state: SessionState): string {
  const params = new URLSearchParams({ from: state.from, to: state.to });
  if (state.agent) params.set("agent", state.agent);
  return `/api/sessions?${params}`;
}

export function detailRequest(id: string): string {
  return `/api/sessions/${id}`;
}

/** New query string with `id`/`agent` set or removed; every other parameter is preserved. */
export function sessionSearch(
  search: string,
  patch: { id?: string | undefined; agent?: SessionAgent | undefined },
): string {
  const params = new URLSearchParams(search);
  for (const key of ["id", "agent"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export interface ContextRow {
  idx: number;
  context: number | null;
  compaction: boolean;
}

/** Turns with usage (context size) plus compaction markers, in idx order (L21). */
export function contextRows(turns: readonly SessionTurn[]): ContextRow[] {
  return turns
    .filter((turn) => turn.contextTokens !== null || turn.isCompaction)
    .map((turn) => ({ idx: turn.idx, context: turn.contextTokens, compaction: turn.isCompaction }));
}

/** Data-free Vega-Lite spec; rows are injected into the `table` dataset at render time. */
export function contextSpec(labels: {
  turn: string;
  context: string;
  compaction: string;
}): Record<string, unknown> {
  const x = { field: "idx", type: "quantitative", title: labels.turn, axis: { tickMinStep: 1 } };
  const legend = { title: null };
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    layer: [
      {
        transform: [{ filter: "datum.context != null" }],
        mark: { type: "line", point: true },
        encoding: {
          x,
          y: {
            field: "context",
            type: "quantitative",
            title: labels.context,
            axis: { format: "~s" },
          },
          color: { datum: labels.context, legend },
          tooltip: [
            { field: "idx", type: "quantitative", title: labels.turn },
            { field: "context", type: "quantitative", title: labels.context, format: "," },
          ],
        },
      },
      {
        transform: [{ filter: "datum.compaction" }],
        mark: { type: "rule" },
        encoding: {
          x,
          color: { datum: labels.compaction, legend },
          tooltip: [{ field: "idx", type: "quantitative", title: labels.compaction }],
        },
      },
    ],
  };
}

export interface ToolSummary {
  tool: string;
  calls: number;
  errors: number;
  /** Sum of known durations; null when no call reported one. */
  durationMs: number | null;
}

/** Per tool: calls, errors and total known duration; most used first, then by name. */
export function toolsSummary(turns: readonly SessionTurn[]): ToolSummary[] {
  const byTool = new Map<string, ToolSummary>();
  for (const call of turns.flatMap((turn) => turn.tools)) {
    const entry = byTool.get(call.tool) ?? {
      tool: call.tool,
      calls: 0,
      errors: 0,
      durationMs: null,
    };
    entry.calls += 1;
    if (call.status === "error") entry.errors += 1;
    if (call.durationMs !== null) entry.durationMs = (entry.durationMs ?? 0) + call.durationMs;
    byTool.set(call.tool, entry);
  }
  return [...byTool.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}
