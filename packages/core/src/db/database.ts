import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";

export type SqlParams = DuckDBValue[];

/** JSON-safe query values: the SQL console transports them as they are (T4). */
export type QueryJson =
  | null
  | boolean
  | number
  | string
  | QueryJson[]
  | { [key: string]: QueryJson };

export interface QueryColumn {
  name: string;
  /** DuckDB type name, e.g. "BIGINT" or "TIMESTAMP WITH TIME ZONE". */
  type: string;
}

export interface QueryOptions {
  /** Maximum rows handed to the caller; the reader may hold up to one chunk more. */
  limit: number;
  /** Milliseconds after which the running statement is interrupted. */
  timeoutMs: number;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: QueryJson[][];
  /** Number of rows handed to the caller (at most `limit`). */
  rowCount: number;
  /** True when the statement produced more rows than `limit`. */
  truncated: boolean;
  elapsedMs: number;
}

/** The statement was interrupted because it exceeded `QueryOptions.timeoutMs`. */
export class QueryTimeoutError extends Error {
  constructor() {
    super("query timed out");
  }
}

/**
 * Thin wrapper over one DuckDB instance and connection.
 * One More Token keeps a single writer (spec §11.1): only the server process opens the database.
 */
export interface Database {
  run(sql: string, params?: SqlParams): Promise<void>;
  all<T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  /** Bounded, interruptible read used by the SQL console; the caller owns read-only enforcement. */
  query(sql: string, options: QueryOptions): Promise<QueryResult>;
  close(): void;
}

export async function openDatabase(path: string): Promise<Database> {
  // The warehouse never reads or writes files through SQL. The SQL console (spec §7.1) accepts
  // arbitrary query expressions, so DuckDB table functions such as `read_text` or `read_csv`
  // would otherwise hand any local file to the browser. External access is closed for the whole
  // instance at open time: it is a database-wide setting that cannot be reopened later, which is
  // exactly the guarantee this product needs. Ingestion reads agent files from Node, never via SQL.
  const instance = await DuckDBInstance.create(path, { enable_external_access: "false" });
  const connection = await instance.connect();
  return {
    async run(sql, params) {
      await connection.run(sql, params);
    },
    async all<T extends Record<string, unknown>>(sql: string, params?: SqlParams) {
      const reader = await connection.runAndReadAll(sql, params);
      return reader.getRowObjectsJS() as T[];
    },
    async query(sql, options) {
      const started = performance.now();
      let expired = false;
      // The queue serializes operations, so interrupting hits this statement and nothing else.
      const timer = setTimeout(() => {
        expired = true;
        try {
          connection.interrupt();
        } catch {
          // A closed connection needs no interruption.
        }
      }, options.timeoutMs);
      try {
        const reader = await connection.runAndReadUntil(sql, options.limit + 1);
        const columns = reader.columnNames().map((name, index) => ({
          name,
          type: reader.columnType(index).toString(),
        }));
        const rows = reader.getRowsJson() as QueryJson[][];
        const kept = rows.slice(0, options.limit);
        return {
          columns,
          rows: kept,
          rowCount: kept.length,
          truncated: rows.length > options.limit,
          elapsedMs: Math.round(performance.now() - started),
        };
      } catch (error) {
        if (expired) throw new QueryTimeoutError();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
