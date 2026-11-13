import { type Database, MAX_SQL_LENGTH, type QueryResult, QueryTimeoutError } from "@omt/core";
import { withDatabase } from "../db-queue";

/** Bounded request body for the console (T4). */
export const MAX_SQL_BYTES = 64 * 1024;
/** Rows handed to the browser; the reader may hold up to one DuckDB chunk more. */
export const SQL_ROW_LIMIT = 1000;
export const SQL_TIMEOUT_MS = 5000;
/** DuckDB diagnostics are one bounded line: never a stack, a path or a huge message. */
const MAX_MESSAGE = 300;

export interface SqlLimits {
  limit: number;
  timeoutMs: number;
}

/** The body was not a single, non-empty query string. */
export class InvalidSqlError extends Error {
  constructor() {
    super("invalid sql");
  }
}

/**
 * The text of one console request: trimmed and non-empty. A second statement is caught by the
 * wrapper in `guardSql`, never by scanning for semicolons: `SELECT ';'` and `LIKE '%;%'` are valid
 * queries, and DuckDB rejects `SELECT 1; DROP TABLE t` inside a subquery at parse time.
 */
export function parseSqlBody(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidSqlError();
  }
  const sql = (input as { sql?: unknown }).sql;
  if (typeof sql !== "string" || sql.length > MAX_SQL_LENGTH) throw new InvalidSqlError();
  // Trailing whitespace and one run of trailing semicolons are noise, nothing else is dropped.
  const trimmed = sql.replace(/[\s;]+$/, "").trim();
  if (!trimmed) throw new InvalidSqlError();
  return trimmed;
}

/** One bounded line of a DuckDB diagnostic, or a fixed fallback. */
export function sqlMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : "";
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line ? line.slice(0, MAX_MESSAGE) : "query failed";
}

/**
 * Read-only enforcement (T4): DuckDB is asked for `SELECT * FROM (<sql>)`, so only one query
 * expression parses. Statements (INSERT, CREATE, ATTACH, COPY, PRAGMA, CALL, SET, …) and any
 * second statement never reach execution.
 */
export function guardSql(sql: string): string {
  return `SELECT * FROM (\n${sql}\n)`;
}

export async function runSql(
  db: Database,
  sql: string,
  limits: SqlLimits = { limit: SQL_ROW_LIMIT, timeoutMs: SQL_TIMEOUT_MS },
): Promise<QueryResult> {
  return withDatabase(db, () =>
    db.query(guardSql(sql), { limit: limits.limit, timeoutMs: limits.timeoutMs }),
  );
}

export { QueryTimeoutError };
