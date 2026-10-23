import { describe, expect, it } from "vitest";
import {
  buildChartSpec,
  chartRequirement,
  deriveViewId,
  EXPLORER_DIMENSIONS,
  EXPLORER_METRICS,
  injectData,
  localizeSpec,
  metricKind,
  parseExplorerState,
  parseFilterValues,
  prepareData,
  resolveViewId,
  serializeExplorerState,
  stateToView,
  viewRangeToPeriod,
} from "../src/explorer/state";

const NOW = Date.parse("2026-02-01T00:00:00.000Z");
const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-01-08T00:00:00.000Z";

describe("parseExplorerState / serializeExplorerState (S6-S9, S11: URL keeps the state)", () => {
  it("defaults to total tokens by day over the last 7 days with a clean URL", () => {
    const state = parseExplorerState("", NOW);
    expect(state).toEqual({
      metrics: ["total"],
      dimensions: ["day"],
      filters: [],
      chart: "bar",
      from: "2026-01-25T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
      view: undefined,
    });
    expect(serializeExplorerState(state).toString()).toBe(
      `from=${encodeURIComponent("2026-01-25T00:00:00.000Z")}&to=${encodeURIComponent("2026-02-01T00:00:00.000Z")}`,
    );
  });

  it("round-trips metrics, dimensions, chart, filters and the loaded view", () => {
    const query =
      `metrics=total%2CcomputedCost&dimensions=day%2Cagent&chart=barStacked` +
      `&filters=${encodeURIComponent(JSON.stringify([{ dimension: "agent", op: "in", values: ["pi"] }]))}` +
      `&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&view=my-view`;
    const state = parseExplorerState(`?${query}`, NOW);
    expect(state.metrics).toEqual(["total", "computedCost"]);
    expect(state.dimensions).toEqual(["day", "agent"]);
    expect(state.chart).toBe("barStacked");
    expect(state.filters).toEqual([{ dimension: "agent", op: "in", values: ["pi"] }]);
    expect(state.view).toBe("my-view");
    const serialized = serializeExplorerState(state).toString();
    expect(serialized).toBe(query.replace(/\+/g, "%2B"));
  });

  it("rejects unknown metrics, extra dimensions, bad charts, invalid dates and broken filters", () => {
    const state = parseExplorerState(
      `?metrics=total%2Cbogus&dimensions=day%2Cagent%2Cmodel&chart=pie` +
        `&from=nope&to=${encodeURIComponent(TO)}` +
        `&filters=${encodeURIComponent('[{"dimension":"bogus"}]')}`,
      NOW,
    );
    expect(state.metrics).toEqual(["total"]);
    expect(state.dimensions).toEqual(["day", "agent"]);
    expect(state.chart).toBe("bar");
    expect(state.from).toBe("2026-01-25T00:00:00.000Z");
    expect(state.filters).toEqual([]);
  });

  it("treats an explicit empty dimensions parameter as zero dimensions", () => {
    expect(parseExplorerState("?dimensions=", NOW).dimensions).toEqual([]);
  });
});

describe("deriveViewId / resolveViewId (S13: id derived from the name)", () => {
  it("lowercases, strips accents, dashes separators and caps at 64 chars", () => {
    expect(deriveViewId("Crédito  Rápido!!")).toBe("credito-rapido");
    expect(deriveViewId("  --Óptimo_ñandú-- ")).toBe("optimo-nandu");
    expect(deriveViewId("a".repeat(80))).toBe("a".repeat(64));
    expect(deriveViewId(`${"x".repeat(63)}-/-`)).toBe("x".repeat(63));
  });

  it("falls back to a generic id for names without slug characters", () => {
    expect(deriveViewId("!!!")).toBe("view");
    expect(deriveViewId("日本語")).toBe("view");
  });

  it("keeps the id of the view being edited and suffixes real collisions", () => {
    const taken = new Set(["mi-vista", "otra", "otra-2"]);
    expect(resolveViewId("mi-vista", taken, "mi-vista")).toBe("mi-vista");
    expect(resolveViewId("otra", taken)).toBe("otra-3");
    expect(resolveViewId("otra-2", taken, "otra-2")).toBe("otra-2");
    expect(resolveViewId("nueva", taken)).toBe("nueva");
  });

  it("keeps suffixed ids within the 64-char limit", () => {
    const base = "a".repeat(64);
    const taken = new Set([base]);
    const id = resolveViewId(base, taken);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toBe(`${"a".repeat(62)}-2`);
  });
});

describe("chartRequirement (S8: chart compatibility)", () => {
  const shape = (metrics: number, dimensions: number) => ({ metrics, dimensions });
  it("accepts basic charts with any supported shape", () => {
    for (const chart of ["bar", "barStacked", "barGrouped", "line", "area"] as const) {
      expect(chartRequirement(chart, shape(1, 0))).toEqual({ ok: true });
      expect(chartRequirement(chart, shape(4, 2))).toEqual({ ok: true });
    }
  });

  it("requires two dimensions for heatmaps, exactly two for sankey, one for treemap", () => {
    expect(chartRequirement("heatmap", shape(1, 1))).toEqual({
      ok: false,
      reason: "twoDimensions",
    });
    expect(chartRequirement("heatmap", shape(1, 2))).toEqual({ ok: true });
    expect(chartRequirement("sankey", shape(1, 1))).toEqual({
      ok: false,
      reason: "exactlyTwoDimensions",
    });
    expect(chartRequirement("sankey", shape(1, 2))).toEqual({ ok: true });
    expect(chartRequirement("treemap", shape(1, 0))).toEqual({
      ok: false,
      reason: "oneDimension",
    });
    expect(chartRequirement("treemap", shape(1, 1))).toEqual({ ok: true });
  });

  it("requires two metrics for scatter", () => {
    expect(chartRequirement("scatter", shape(1, 1))).toEqual({ ok: false, reason: "twoMetrics" });
    expect(chartRequirement("scatter", shape(2, 0))).toEqual({ ok: true });
  });
});

describe("buildChartSpec (S8, L5: Vega-Lite specs; treemap/sankey in Vega)", () => {
  it("builds a stacked bar spec with a temporal day axis", () => {
    const spec = buildChartSpec({
      chart: "barStacked",
      dimensions: ["day", "agent"],
      metrics: ["total"],
    }) as unknown as Record<string, unknown>;
    expect(spec.$schema).toBe("https://vega.github.io/schema/vega-lite/v6.json");
    expect(spec.data).toEqual({ name: "table" });
    expect(spec.mark).toEqual({ type: "bar" });
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x).toMatchObject({ field: "day", type: "temporal" });
    expect(encoding.y).toMatchObject({ field: "total", stack: "zero" });
    expect(encoding.color).toMatchObject({ field: "agent" });
  });

  it("folds several metrics so a grouped bar compares computed and reported cost", () => {
    const spec = buildChartSpec({
      chart: "barGrouped",
      dimensions: ["model"],
      metrics: ["computedCost", "reportedCost"],
    }) as unknown as Record<string, unknown>;
    expect(spec.transform).toEqual([
      { fold: ["computedCost", "reportedCost"], as: ["metric", "value"] },
    ]);
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x).toMatchObject({ field: "model" });
    expect(encoding.y).toMatchObject({ field: "value" });
    expect(encoding.color).toMatchObject({ field: "metric" });
  });

  it("builds a heatmap with ordinal hour and weekday axes", () => {
    const spec = buildChartSpec({
      chart: "heatmap",
      dimensions: ["hourOfDay", "dayOfWeek"],
      metrics: ["turns"],
    }) as unknown as Record<string, unknown>;
    expect(spec.mark).toEqual({ type: "rect" });
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x).toMatchObject({ field: "hourOfDay", type: "ordinal" });
    expect(encoding.y).toMatchObject({ field: "dayOfWeek", type: "ordinal" });
    expect(encoding.color).toMatchObject({ field: "turns", type: "quantitative" });
  });

  it("builds a scatter spec from the first two metrics", () => {
    const spec = buildChartSpec({
      chart: "scatter",
      dimensions: ["model"],
      metrics: ["input", "output", "total"],
    }) as unknown as Record<string, unknown>;
    const encoding = spec.encoding as Record<string, Record<string, unknown>>;
    expect(encoding.x).toMatchObject({ field: "input", type: "quantitative" });
    expect(encoding.y).toMatchObject({ field: "output", type: "quantitative" });
    expect(encoding.color).toMatchObject({ field: "model" });
  });

  it("builds treemap and sankey as Vega specs without embedded data (L5, L16)", () => {
    for (const [chart, dimensions] of [
      ["treemap", ["agent"]],
      ["sankey", ["agent", "tool"]],
    ] as const) {
      const spec = buildChartSpec({ chart, dimensions: [...dimensions], metrics: ["total"] });
      const text = JSON.stringify(spec);
      expect(spec.$schema).toBe("https://vega.github.io/schema/vega/v6.json");
      expect(text).not.toContain('"values"');
      expect(text).not.toContain('"url"');
    }
  });
});

describe("prepareData (L16/L17: null groups labelled, derived datasets)", () => {
  const rows = [
    { agent: "pi", tool: "read", total: 3 },
    { agent: null, tool: "read", total: 2 },
    { agent: "pi", tool: null, total: 1 },
  ];

  it("maps null dimension values to the translated no-value label", () => {
    const { table } = prepareData("bar", ["agent", "tool"], "total", rows, "(none)");
    expect(table[1]?.agent).toBe("(none)");
    expect(table[2]?.tool).toBe("(none)");
    expect(table[0]?.agent).toBe("pi");
    expect(rows[1]?.agent).toBeNull();
  });

  it("builds a stratified tree for treemaps with leaf values", () => {
    const { tree } = prepareData("treemap", ["agent", "tool"], "total", rows, "(none)");
    const byId = new Map(tree.map((node) => [node.id, node]));
    const root = byId.get("root");
    expect(root?.parent).toBeUndefined();
    const leaves = tree.filter((node) => node.value !== undefined);
    expect(leaves).toHaveLength(3);
    expect(leaves.reduce((sum, node) => sum + (node.value ?? 0), 0)).toBe(6);
    const piRead = leaves.find((node) => node.label === "read" && node.group === "pi");
    expect(piRead?.value).toBe(3);
  });

  it("lays out a sankey conserving flow between both columns", () => {
    const { nodes, links } = prepareData("sankey", ["agent", "tool"], "total", rows, "(none)");
    const left = nodes.filter((node) => node.side === "left");
    const right = nodes.filter((node) => node.side === "right");
    expect(left.map((node) => node.label)).toEqual(["pi", "(none)"]);
    expect(right.map((node) => node.label)).toEqual(["read", "(none)"]);
    const linkTotal = links.reduce((sum, link) => sum + link.value, 0);
    const leftTotal = left.reduce((sum, node) => sum + (node.y1 - node.y0), 0);
    const rightTotal = right.reduce((sum, node) => sum + (node.y1 - node.y0), 0);
    expect(linkTotal).toBe(6);
    expect(leftTotal).toBeCloseTo(rightTotal, 6);
    for (const link of links) {
      expect(link.path.startsWith("M")).toBe(true);
      expect(link.path.endsWith("Z")).toBe(true);
    }
  });

  it("returns empty sankey datasets when every value is zero", () => {
    const { nodes, links } = prepareData(
      "sankey",
      ["agent", "tool"],
      "total",
      [{ agent: "pi", tool: "read", total: 0 }],
      "(none)",
    );
    expect(nodes).toEqual([]);
    expect(links).toEqual([]);
  });
});

describe("injectData (L16: data injected at render time, never stored)", () => {
  it("injects values into named Vega-Lite data and named Vega datasets only", () => {
    const vl = { data: { name: "table" }, mark: { type: "bar" } };
    const injected = injectData(vl, { table: [{ a: 1 }] }) as unknown as Record<string, unknown>;
    expect(injected.data).toEqual({ name: "table", values: [{ a: 1 }] });
    expect(vl.data).toEqual({ name: "table" });

    const vega = {
      data: [
        { name: "tree", transform: [] },
        { name: "leaves", source: "tree", transform: [] },
        { name: "remote", url: "https://example.invalid/x.json" },
      ],
    };
    const out = injectData(vega, { tree: [{ id: "root" }] }) as Record<
      string,
      Array<Record<string, unknown>>
    >;
    expect(out.data?.[0]).toMatchObject({ name: "tree", values: [{ id: "root" }] });
    expect(out.data?.[1]).toEqual({ name: "leaves", source: "tree", transform: [] });
    expect(out.data?.[2]).toEqual({ name: "remote", url: "https://example.invalid/x.json" });
  });
});

describe("stateToView / viewRangeToPeriod (S9, S13: save and load views)", () => {
  const state = {
    metrics: ["total", "computedCost"] as const,
    dimensions: ["day", "agent"] as const,
    filters: [{ dimension: "agent" as const, op: "in" as const, values: ["pi"] }],
    chart: "barStacked" as const,
    from: FROM,
    to: TO,
    view: undefined,
  };

  it("serializes the current state as an omt.saved-view/1 body with a relative range", () => {
    const view = stateToView(
      { ...state, metrics: [...state.metrics], dimensions: [...state.dimensions] },
      {
        id: "mi-vista",
        name: "Mi Vista",
      },
    );
    expect(view.schema).toBe("omt.saved-view/1");
    expect(view.id).toBe("mi-vista");
    expect(view.name).toBe("Mi Vista");
    expect(view.query).toEqual({
      metrics: ["total", "computedCost"],
      dimensions: ["day", "agent"],
      filters: [{ dimension: "agent", op: "in", values: ["pi"] }],
      range: "last7Days",
    });
    expect(view.chart.type).toBe("barStacked");
    expect(view.chart.encoding).toEqual({ x: "day", y: "total", color: "agent" });
    for (const field of Object.values(view.chart.encoding)) {
      expect([...view.query.metrics, ...view.query.dimensions]).toContain(field);
    }
    const text = JSON.stringify(view.spec);
    expect(text).not.toContain('"values"');
    expect(text).not.toContain('"url"');
  });

  it("keeps custom periods as absolute ranges", () => {
    const view = stateToView(
      {
        metrics: ["turns"],
        dimensions: ["agent"],
        filters: [],
        chart: "bar",
        from: FROM,
        to: "2026-01-06T00:00:00.000Z",
        view: undefined,
      },
      { id: "custom", name: "Custom" },
    );
    expect(view.query.range).toEqual({ from: FROM, to: "2026-01-06T00:00:00.000Z" });
  });

  it("expands relative ranges against now and keeps absolute ones", () => {
    expect(viewRangeToPeriod("last30Days", NOW)).toEqual({
      from: "2026-01-02T00:00:00.000Z",
      to: "2026-02-01T00:00:00.000Z",
    });
    expect(viewRangeToPeriod({ from: FROM, to: TO }, NOW)).toEqual({ from: FROM, to: TO });
  });
});

describe("metricKind (S9: tokens in M with one decimal, costs in USD)", () => {
  it("classifies every metric", () => {
    expect(metricKind("input")).toBe("tokens");
    expect(metricKind("output")).toBe("tokens");
    expect(metricKind("cacheRead")).toBe("tokens");
    expect(metricKind("cacheWrite")).toBe("tokens");
    expect(metricKind("total")).toBe("tokens");
    expect(metricKind("computedCost")).toBe("usd");
    expect(metricKind("reportedCost")).toBe("usd");
    expect(metricKind("cacheHitRatio")).toBe("ratio");
    expect(metricKind("turns")).toBe("count");
    expect(metricKind("sessions")).toBe("count");
  });

  it("mirrors the closed metric and dimension enums of the pivot contract (S6, S7)", () => {
    expect(EXPLORER_METRICS).toEqual([
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
      "computedCost",
      "reportedCost",
      "cacheHitRatio",
      "turns",
      "sessions",
    ]);
    expect(EXPLORER_DIMENSIONS).toContain("subscription");
    expect(EXPLORER_DIMENSIONS).toContain("hourOfDay");
    expect(EXPLORER_DIMENSIONS).toHaveLength(13);
  });
});

describe("localizeSpec (L17: folded cost fields are labelled computed and reported; S9 units)", () => {
  const labels = {
    computedCost: "Computed cost",
    reportedCost: "Reported cost",
    model: "Model",
    total: "Total tokens",
    agent: "Agent",
  };
  const fold = { key: "Metric", value: "Value" };
  const costByModel = {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    transform: [{ fold: ["computedCost", "reportedCost"], as: ["cost", "usd"] }],
    mark: { type: "bar" },
    encoding: {
      x: { field: "model", type: "nominal" },
      xOffset: { field: "cost", type: "nominal" },
      y: { field: "usd", type: "quantitative" },
      color: { field: "cost", type: "nominal" },
    },
  };

  it("maps folded metric names to translated labels right after the fold", () => {
    const out = localizeSpec(costByModel, labels, fold) as typeof costByModel & {
      transform: Array<Record<string, unknown>>;
    };
    expect(out.transform[0]).toEqual(costByModel.transform[0]);
    expect(out.transform[1]?.as).toBe("cost");
    const expr = String(out.transform[1]?.calculate);
    expect(expr).toContain('"computedCost":"Computed cost"');
    expect(expr).toContain('"reportedCost":"Reported cost"');
    expect(costByModel.transform).toHaveLength(1);
  });

  it("titles channels and formats folded cost values as USD", () => {
    const out = localizeSpec(costByModel, labels, fold) as unknown as {
      encoding: Record<string, Record<string, unknown>>;
    };
    expect(out.encoding.x?.title).toBe("Model");
    expect(out.encoding.color?.title).toBe("Metric");
    expect(out.encoding.y?.title).toBe("Value");
    expect(out.encoding.y?.axis).toEqual({ format: "$,.2f" });
  });

  it("labels token axes in millions with one decimal and keeps explicit titles and axes", () => {
    const out = localizeSpec(
      {
        $schema: "https://vega.github.io/schema/vega-lite/v6.json",
        encoding: {
          x: { field: "agent", type: "nominal", title: "Kept" },
          y: { field: "total", type: "quantitative" },
          color: { field: "cacheHitRatio", type: "quantitative", axis: { format: "%" } },
        },
      },
      labels,
      fold,
    ) as unknown as { encoding: Record<string, Record<string, unknown>> };
    expect(out.encoding.x?.title).toBe("Kept");
    expect(out.encoding.y?.title).toBe("Total tokens");
    expect(
      String((out.encoding.y?.axis as Record<string, unknown> | undefined)?.labelExpr),
    ).toContain("/ 1000000");
    expect(out.encoding.color?.axis).toEqual({ format: "%" });
  });

  it("leaves Vega specs untouched", () => {
    const vega = { $schema: "https://vega.github.io/schema/vega/v6.json", marks: [] };
    expect(localizeSpec(vega, labels, fold)).toEqual(vega);
  });
});

describe("parseFilterValues (S9: filter values match the contract bounds)", () => {
  it("trims, drops empty and over-long values, dedupes and caps at 50", () => {
    expect(parseFilterValues(" pi, claude ,,pi ")).toEqual(["pi", "claude"]);
    expect(parseFilterValues(`ok,${"x".repeat(257)}`)).toEqual(["ok"]);
    expect(parseFilterValues(Array.from({ length: 60 }, (_, i) => `v${i}`).join(","))).toHaveLength(
      50,
    );
    expect(parseFilterValues(" , ")).toEqual([]);
  });
});
