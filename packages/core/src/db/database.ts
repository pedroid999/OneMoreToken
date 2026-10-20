import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";

export type SqlParams = DuckDBValue[];

/**
 * Thin wrapper over one DuckDB instance and connection.
 * One More Token keeps a single writer (spec §11.1): only the server process opens the database.
 */
export interface Database {
  run(sql: string, params?: SqlParams): Promise<void>;
  all<T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  close(): void;
}

export async function openDatabase(path: string): Promise<Database> {
  const instance = await DuckDBInstance.create(path);
  const connection = await instance.connect();
  return {
    async run(sql, params) {
      await connection.run(sql, params);
    },
    async all<T extends Record<string, unknown>>(sql: string, params?: SqlParams) {
      const reader = await connection.runAndReadAll(sql, params);
      return reader.getRowObjectsJS() as T[];
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}
