import { describe, expect, it } from "vitest";
import type { ToolDaily, ToolsReport } from "../src/tools/contract";
import { dailyRows, dailySpec, toolsRequest, toolsTotals, topTools } from "../src/tools/state";

const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";

const tokenTotals = (total: number) => ({
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
});

const toolRow = (tool: string, calls: number, total: number): ToolsReport["tools"][number] => ({
  tool,
  rawNames: [tool],
  calls,
  errors: 0,
  errorStatusKnown: true,
  turns: calls,
  sharedTurns: 0,
  durationKnownMs: 0,
  durationAvgKnownMs: null,
  tokens: tokenTotals(total),
  computedCostUsd: null,
  reportedCostUsd: null,
  costKnownTurns: calls,
  costUnknownTurns: 0,
});

const daily = (rows: readonly (readonly [string, string, number])[]): ToolDaily[] =>
  rows.map(([day, tool, tokens]) => ({ day, tool, tokens }));

describe("tools state (Phase 5 L3)", () => {
  it("requests only the period's report", () => {
    expect(toolsRequest({ from, to })).toBe(
      `/api/tools?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  });

  it("sums calls and turn tokens over the returned tools", () => {
    expect(
      toolsTotals({
        period: { from, to },
        tools: [toolRow("read", 12, 2_000_000), toolRow("bash", 5, 500_000)],
        daily: [],
        byAgent: [],
      }),
    ).toEqual({ calls: 17, tools: 2, tokens: 2_500_000 });
  });

  it("charts the tools with the most turn tokens, keeping at most the limit", () => {
    const rows = daily([
      ["2026-01-02", "a", 100],
      ["2026-01-02", "b", 900],
      ["2026-01-02", "c", 500],
      ["2026-01-02", "d", 300],
      ["2026-01-02", "e", 200],
      ["2026-01-02", "f", 50],
    ]);
    expect(topTools(rows, 5)).toEqual(["b", "c", "d", "e", "a"]);
    expect(topTools(rows)).toHaveLength(5);
  });

  it("breaks token ties by name so the series order is stable", () => {
    const rows = daily([
      ["2026-01-02", "write", 100],
      ["2026-01-02", "read", 100],
    ]);
    expect(topTools(rows, 2)).toEqual(["read", "write"]);
  });

  it("keeps only the charted tools, in the server's day order", () => {
    const rows = daily([
      ["2026-01-02", "read", 10],
      ["2026-01-02", "bash", 20],
      ["2026-01-03", "read", 30],
    ]);
    expect(dailyRows(rows, ["read"])).toEqual([
      { day: "2026-01-02", tool: "read", tokens: 10 },
      { day: "2026-01-03", tool: "read", tokens: 30 },
    ]);
  });

  it("builds a data-free spec: one line per tool, days on the x axis (spec §7.3)", () => {
    const spec = dailySpec({
      day: "Day",
      tokens: "Tokens",
      tool: "Tool",
      tools: ["read", "bash"],
      colors: ["#111111", "#222222"],
    });
    expect(spec.data).toEqual({ name: "table" });
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x?.field).toBe("day");
    expect(encoding.y?.field).toBe("tokens");
    expect(encoding.color?.field).toBe("tool");
    expect(encoding.color?.scale).toEqual({
      domain: ["read", "bash"],
      range: ["#111111", "#222222"],
    });
  });
});
