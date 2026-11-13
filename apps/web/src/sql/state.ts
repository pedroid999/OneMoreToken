// Pure SQL console state (spec §7.1, Phase 4 T4): endpoints, cell text and error classification.
// No React, no fetch.
import { deriveViewId, resolveViewId } from "../explorer/state";

export const SQL_QUERY_PATH = "/api/sql/query";
export const SAVED_QUERIES_PATH = "/api/sql/views";

/** First query shown in the editor; SQL text, not UI copy, so it is not translated. */
export const DEFAULT_SQL = `SELECT agent, count(*) AS sessions
FROM sessions
GROUP BY agent
ORDER BY sessions DESC`;

export function savedQueryPath(id: string): string {
  return `${SAVED_QUERIES_PATH}/${encodeURIComponent(id)}`;
}

/** A stored query keeps its id when it is overwritten; any other collision gets a suffix. */
export function nextSavedQueryId(
  name: string,
  taken: ReadonlySet<string>,
  keepId?: string,
): string {
  return resolveViewId(deriveViewId(name), taken, keepId);
}

/** Cells are DuckDB JSON values: scalars as text, arrays and objects as compact JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export type SqlFailureKind = "invalid" | "timeout" | "failed" | "unavailable";

export interface SqlFailure {
  kind: SqlFailureKind;
  /** DuckDB's own one-line diagnostic, when the server sent one. */
  message?: string;
}

/** Maps the fixed API diagnostics to the message the console shows. */
export function sqlFailure(payload: unknown): SqlFailure {
  if (typeof payload !== "object" || payload === null) return { kind: "unavailable" };
  const { error, message } = payload as { error?: unknown; message?: unknown };
  if (error === "query timed out") return { kind: "timeout" };
  if (error === "invalid sql") return { kind: "invalid" };
  if (error === "query failed") {
    return {
      kind: "failed",
      ...(typeof message === "string" && message ? { message } : {}),
    };
  }
  return { kind: "unavailable" };
}
