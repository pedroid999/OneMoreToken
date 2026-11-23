// Pure Tools view state: request, period totals, the top tools of the chart and their daily
// series (spec §7.1.8, §7.3; feature doc S3, S7). No React, no fetch.
import type { QuotasPeriod } from "../quotas/state";
import type { ToolDaily, ToolsReport } from "./contract";

/** Only the period drives the request; other URL state never refetches. */
export function toolsRequest(period: QuotasPeriod): string {
  return `/api/tools?${new URLSearchParams({ from: period.from, to: period.to })}`;
}

export interface ToolsTotals {
  calls: number;
  tools: number;
  /**
   * Tokens of the turns that used the tools: every turn counts once per tool it used, so the
   * total overlaps and is only a reading of the table (spec §7.3, S3).
   */
  tokens: number;
}

export function toolsTotals(report: ToolsReport): ToolsTotals {
  return {
    calls: report.tools.reduce((total, tool) => total + tool.calls, 0),
    tools: report.tools.length,
    tokens: report.tools.reduce((total, tool) => total + tool.tokens.total, 0),
  };
}

/** How many tools the daily chart keeps; the rest stay auditable in the tables. */
export const TOP_TOOLS = 5;

/** Tools with the most turn tokens, ties broken by name so the series order is stable. */
export function topTools(daily: readonly ToolDaily[], limit: number = TOP_TOOLS): string[] {
  const tokens = new Map<string, number>();
  for (const row of daily) tokens.set(row.tool, (tokens.get(row.tool) ?? 0) + row.tokens);
  return [...tokens.entries()]
    .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
    .slice(0, limit)
    .map(([tool]) => tool);
}

export interface DailyChartRow {
  day: string;
  tool: string;
  tokens: number;
}

/** Only the charted tools, keeping the server's day order. */
export function dailyRows(daily: readonly ToolDaily[], tools: readonly string[]): DailyChartRow[] {
  const charted = new Set(tools);
  return daily
    .filter((row) => charted.has(row.tool))
    .map((row) => ({ day: row.day, tool: row.tool, tokens: row.tokens }));
}

/** Data-free Vega-Lite spec: one line per tool, days on the x axis; rows go into `table`. */
export function dailySpec(labels: {
  day: string;
  tokens: string;
  tool: string;
  tools: readonly string[];
  colors: readonly string[];
}): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    mark: { type: "line", point: true, strokeWidth: 2 },
    encoding: {
      x: { field: "day", type: "temporal", timeUnit: "utcyearmonthdate", title: labels.day },
      y: { field: "tokens", type: "quantitative", title: labels.tokens, axis: { format: "~s" } },
      color: {
        field: "tool",
        type: "nominal",
        title: labels.tool,
        scale: { domain: [...labels.tools], range: [...labels.colors] },
      },
      tooltip: [
        { field: "tool", type: "nominal", title: labels.tool },
        { field: "day", type: "temporal", title: labels.day, format: "%x" },
        { field: "tokens", type: "quantitative", title: labels.tokens, format: "," },
      ],
    },
  };
}
