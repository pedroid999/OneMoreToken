// Pure Agents view state: request, class filter, the (task class × agent) chart rows and its
// data-free spec (spec §7.1.6, §7.3; feature doc S2, S6). No React, no fetch.
import type { QuotasPeriod } from "../quotas/state";
import type { AgentClassRow, TaskClassValue } from "./contract";

/** Only the period drives the request; the class filter is view state. */
export function agentsRequest(period: QuotasPeriod): string {
  return `/api/agents?${new URLSearchParams({ from: period.from, to: period.to })}`;
}

export type ClassFilter = "all" | TaskClassValue;

/** Rows of one task class, or every row; the derived/corrected split is kept inside. */
export function filterRows(rows: readonly AgentClassRow[], filter: ClassFilter): AgentClassRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => row.taskClass === filter);
}

export interface ClassAgentChartRow {
  taskClass: TaskClassValue;
  agent: string;
  sessions: number;
  turns: number;
}

/**
 * One bar per (task class, agent). The two sources of the same pair add up: the chart compares
 * the same task class across agents (S6), and the table keeps derived and corrected apart (S2).
 */
export function chartRows(
  rows: readonly AgentClassRow[],
  classes: readonly TaskClassValue[],
): ClassAgentChartRow[] {
  const merged = new Map<string, ClassAgentChartRow>();
  for (const row of rows) {
    const key = `${row.taskClass}\u0000${row.agent}`;
    const entry = merged.get(key) ?? {
      taskClass: row.taskClass,
      agent: row.agent,
      sessions: 0,
      turns: 0,
    };
    entry.sessions += row.sessions;
    entry.turns += row.turns;
    merged.set(key, entry);
  }
  const rank = (value: TaskClassValue) => classes.indexOf(value);
  return [...merged.values()].sort(
    (a, b) => rank(a.taskClass) - rank(b.taskClass) || a.agent.localeCompare(b.agent),
  );
}

/** Distinct agents in name order, the domain of the chart's series colours. */
export function agentsIn(rows: readonly { agent: string }[]): string[] {
  return [...new Set(rows.map((row) => row.agent))].sort((a, b) => a.localeCompare(b));
}

/**
 * Data-free Vega-Lite spec: the task classes on the x axis, one series per agent, so the same
 * class can be compared across agents; rows go into `table`.
 */
export function chartSpec(labels: {
  taskClass: string;
  agent: string;
  sessions: string;
  turns: string;
  classes: readonly string[];
  agents: readonly string[];
  colors: readonly string[];
}): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    mark: { type: "bar", cornerRadiusEnd: 2 },
    encoding: {
      x: {
        field: "taskClass",
        type: "nominal",
        title: labels.taskClass,
        sort: [...labels.classes],
      },
      xOffset: { field: "agent", type: "nominal", sort: [...labels.agents] },
      y: {
        field: "sessions",
        type: "quantitative",
        title: labels.sessions,
        axis: { format: "~s", tickMinStep: 1 },
      },
      color: {
        field: "agent",
        type: "nominal",
        title: labels.agent,
        scale: { domain: [...labels.agents], range: [...labels.colors] },
      },
      tooltip: [
        { field: "taskClass", type: "nominal", title: labels.taskClass },
        { field: "agent", type: "nominal", title: labels.agent },
        { field: "sessions", type: "quantitative", title: labels.sessions, format: "," },
        { field: "turns", type: "quantitative", title: labels.turns, format: "," },
      ],
    },
  };
}
