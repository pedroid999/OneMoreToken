// Wire shapes of the SQL console (spec §7.1, Phase 4 T4). Validation never trusts the server.

export interface SqlColumn {
  name: string;
  type: string;
}

export interface SqlResult {
  columns: SqlColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface SavedQuery {
  schema: string;
  id: string;
  name: string;
  sql: string;
  updatedAt: string;
}

export interface SavedQueryList {
  views: SavedQuery[];
  invalid: { id: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isColumn(value: unknown): value is SqlColumn {
  return isRecord(value) && typeof value.name === "string" && typeof value.type === "string";
}

export function isSqlResult(value: unknown): value is SqlResult {
  if (!isRecord(value)) return false;
  const { columns, rows, rowCount, truncated, elapsedMs } = value;
  return (
    Array.isArray(columns) &&
    columns.every(isColumn) &&
    Array.isArray(rows) &&
    rows.every(Array.isArray) &&
    typeof rowCount === "number" &&
    typeof truncated === "boolean" &&
    typeof elapsedMs === "number"
  );
}

export function isSavedQuery(value: unknown): value is SavedQuery {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.sql === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function isSavedQueryList(value: unknown): value is SavedQueryList {
  if (!isRecord(value)) return false;
  const { views, invalid } = value;
  return (
    Array.isArray(views) &&
    views.every(isSavedQuery) &&
    Array.isArray(invalid) &&
    invalid.every((entry) => isRecord(entry) && typeof entry.id === "string")
  );
}
