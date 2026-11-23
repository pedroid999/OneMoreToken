import { describe, expect, it } from "vitest";
import type { AgentClassRow } from "../src/agents/contract";
import { agentsIn, agentsRequest, chartRows, chartSpec, filterRows } from "../src/agents/state";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";
const CLASSES = ["feature", "inline", "unknown"] as const;

const tokenTotals = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});

const row = (patch: Partial<AgentClassRow> = {}): AgentClassRow => ({
  taskClass: "feature",
  source: "derived",
  agent: "claude-code",
  sessions: 3,
  turns: 30,
  tokens: tokenTotals(3_000_000),
  computedCostUsd: 6,
  reportedCostUsd: null,
  cacheHitRatio: 0.5,
  ...patch,
});

describe("agents state (Phase 5 L3)", () => {
  it("requests only the period's report", () => {
    expect(agentsRequest({ from, to })).toBe(
      `/api/agents?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  });

  it("filters the comparison by task class, keeping every source", () => {
    const rows = [
      row(),
      row({ taskClass: "inline", source: "corrected", sessions: 2 }),
      row({ taskClass: "unknown", agent: "codex" }),
    ];
    expect(filterRows(rows, "all")).toHaveLength(3);
    expect(filterRows(rows, "inline").map((each) => each.source)).toEqual(["corrected"]);
    expect(filterRows(rows, "feature")).toHaveLength(1);
  });

  it("adds derived and corrected sessions of the same class and agent into one bar", () => {
    const rows = [
      row({ sessions: 3, turns: 30 }),
      row({ source: "corrected", sessions: 2, turns: 10 }),
      row({ agent: "codex", taskClass: "unknown", sessions: 4, turns: 12 }),
    ];
    expect(chartRows(rows, CLASSES)).toEqual([
      { taskClass: "feature", agent: "claude-code", sessions: 5, turns: 40 },
      { taskClass: "unknown", agent: "codex", sessions: 4, turns: 12 },
    ]);
  });

  it("orders the classes as the payload declares them and the agents by name", () => {
    const rows = [
      row({ taskClass: "unknown", agent: "codex" }),
      row({ taskClass: "feature", agent: "opencode" }),
      row({ taskClass: "feature", agent: "claude-code" }),
    ];
    expect(chartRows(rows, CLASSES).map((each) => `${each.taskClass}:${each.agent}`)).toEqual([
      "feature:claude-code",
      "feature:opencode",
      "unknown:codex",
    ]);
  });

  it("lists the distinct agents in name order for the chart legend", () => {
    const rows = [row({ agent: "pi" }), row({ agent: "claude-code" }), row({ agent: "codex" })];
    expect(agentsIn(rows)).toEqual(["claude-code", "codex", "pi"]);
  });

  it("builds a data-free spec: task classes on the x axis, one series per agent", () => {
    const spec = chartSpec({
      taskClass: "Task class",
      agent: "Agent",
      sessions: "Sessions",
      turns: "Turns",
      classes: ["Feature", "Inline"],
      agents: ["Claude Code", "Codex"],
      colors: ["#111111", "#222222"],
    });
    expect(spec.data).toEqual({ name: "table" });
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x?.field).toBe("taskClass");
    expect(encoding.x?.sort).toEqual(["Feature", "Inline"]);
    expect(encoding.xOffset?.field).toBe("agent");
    expect(encoding.y?.field).toBe("sessions");
    expect(encoding.color?.scale).toEqual({
      domain: ["Claude Code", "Codex"],
      range: ["#111111", "#222222"],
    });
  });
});
