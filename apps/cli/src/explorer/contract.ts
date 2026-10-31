/** Aggregate-only POST /api/explorer/query contract (spec §7.2, L16). See README for semantics. */
export interface ExplorerColumn {
  name: string;
  /** Cost metrics add `<metric>Known` / `<metric>Unknown` coverage counts after the metrics. */
  type: "dimension" | "metric" | "coverage";
}
/** Dimension values are strings, except hourOfDay (0-23) and dayOfWeek (ISO 1-7) integers. */
export type ExplorerValue = string | number | null;
export interface ExplorerResponse {
  columns: ExplorerColumn[];
  /** One object per group, keyed by column name, ordered by dimension values (nulls last). */
  rows: Record<string, ExplorerValue>[];
  /** True when grouping by tool: a turn counts once per distinct tool, so groups overlap. */
  overlapping: boolean;
  /** True when more groups exist than `limit`. */
  truncated: boolean;
}
