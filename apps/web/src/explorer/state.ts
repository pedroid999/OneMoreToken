// Pure Explorer state: URL (de)serialization, view id derivation, chart specs and dataset
// preparation (spec §7.2, §8.1; L5, L16, L17). No React, no fetch: every rule is unit-tested.

const DAY = 86_400_000;

/** Closed enums mirrored from packages/core/src/data/views.ts; the server rejects anything else. */
export const EXPLORER_METRICS = [
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
] as const;
export type ExplorerMetric = (typeof EXPLORER_METRICS)[number];

export const EXPLORER_DIMENSIONS = [
  "agent",
  "model",
  "provider",
  "subscription",
  "profile",
  "attribution",
  "role",
  "effort",
  "repo",
  "branch",
  "tool",
  "day",
  "hourOfDay",
  "dayOfWeek",
] as const;
export type ExplorerDimension = (typeof EXPLORER_DIMENSIONS)[number];

export const EXPLORER_CHARTS = [
  "bar",
  "barStacked",
  "barGrouped",
  "line",
  "area",
  "heatmap",
  "treemap",
  "sankey",
  "scatter",
] as const;
export type ExplorerChart = (typeof EXPLORER_CHARTS)[number];

export interface ExplorerFilter {
  dimension: ExplorerDimension;
  op: "in" | "notIn";
  values: string[];
}

export interface ExplorerState {
  metrics: ExplorerMetric[];
  dimensions: ExplorerDimension[];
  filters: ExplorerFilter[];
  chart: ExplorerChart;
  /** ISO bounds of the half-open [from, to) period (L16). */
  from: string;
  to: string;
  /** Id of the saved view the state came from; cleared by any manual change. */
  view?: string | undefined;
}

export const RELATIVE_RANGES = {
  last7Days: 7,
  last30Days: 30,
  last90Days: 90,
  last365Days: 365,
} as const;
export type RelativeRange = keyof typeof RELATIVE_RANGES;
export type ViewRange = RelativeRange | { from: string; to: string };

const DEFAULT_METRICS: ExplorerMetric[] = ["total"];
const DEFAULT_DIMENSIONS: ExplorerDimension[] = ["day"];
const DEFAULT_CHART: ExplorerChart = "bar";
export const MAX_METRICS = 4;
export const MAX_DIMENSIONS = 2;
export const MAX_FILTERS = 10;
export const VIEW_ID = /^[a-z0-9-]{1,64}$/;

const isMetric = (value: string): value is ExplorerMetric =>
  (EXPLORER_METRICS as readonly string[]).includes(value);
const isDimension = (value: string): value is ExplorerDimension =>
  (EXPLORER_DIMENSIONS as readonly string[]).includes(value);
const isChart = (value: string): value is ExplorerChart =>
  (EXPLORER_CHARTS as readonly string[]).includes(value);

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function parseList<T extends string>(
  raw: string | null,
  guard: (value: string) => value is T,
  max: number,
): T[] | null {
  if (raw === null) return null;
  const values = unique(raw.split(",").filter(guard)).slice(0, max);
  return values;
}

function parseFilters(raw: string | null): ExplorerFilter[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const filters: ExplorerFilter[] = [];
  for (const item of parsed) {
    if (filters.length >= MAX_FILTERS) break;
    if (typeof item !== "object" || item === null) continue;
    const { dimension, op, values } = item as Record<string, unknown>;
    if (typeof dimension !== "string" || !isDimension(dimension)) continue;
    if (op !== "in" && op !== "notIn") continue;
    if (!Array.isArray(values) || values.length < 1 || values.length > 50) continue;
    if (!values.every((v) => typeof v === "string" && v.length >= 1 && v.length <= 256)) continue;
    filters.push({ dimension, op, values: values as string[] });
  }
  return filters;
}

export function parseExplorerState(search: string, now: number): ExplorerState {
  const params = new URLSearchParams(search);
  const metrics = parseList(params.get("metrics"), isMetric, MAX_METRICS);
  let dimensions: ExplorerDimension[];
  if (!params.has("dimensions")) dimensions = [...DEFAULT_DIMENSIONS];
  else dimensions = parseList(params.get("dimensions"), isDimension, MAX_DIMENSIONS) ?? [];
  const chartParam = params.get("chart");
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const valid =
    fromParam !== null &&
    toParam !== null &&
    !Number.isNaN(Date.parse(fromParam)) &&
    !Number.isNaN(Date.parse(toParam)) &&
    Date.parse(fromParam) < Date.parse(toParam);
  const viewParam = params.get("view");
  return {
    metrics: metrics && metrics.length > 0 ? metrics : [...DEFAULT_METRICS],
    dimensions,
    filters: parseFilters(params.get("filters")),
    chart: chartParam && isChart(chartParam) ? chartParam : DEFAULT_CHART,
    from: valid ? new Date(fromParam).toISOString() : new Date(now - 7 * DAY).toISOString(),
    to: valid ? new Date(toParam).toISOString() : new Date(now).toISOString(),
    view: viewParam && VIEW_ID.test(viewParam) ? viewParam : undefined,
  };
}

/** Defaults stay out of the URL, so a bare link always shows the default exploration (spec §8.1). */
export function serializeExplorerState(state: ExplorerState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.metrics.join(",") !== DEFAULT_METRICS.join(","))
    params.set("metrics", state.metrics.join(","));
  if (state.dimensions.join(",") !== DEFAULT_DIMENSIONS.join(","))
    params.set("dimensions", state.dimensions.join(","));
  if (state.chart !== DEFAULT_CHART) params.set("chart", state.chart);
  if (state.filters.length > 0) params.set("filters", JSON.stringify(state.filters));
  params.set("from", state.from);
  params.set("to", state.to);
  if (state.view) params.set("view", state.view);
  return params;
}

/** Slug for the saved-view id: lowercase, accents stripped, dashed, 64 chars max (L17). */
export function deriveViewId(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "view";
}

/**
 * Free id for a save: the id of the view being edited is kept (PUT overwrites it); any other
 * collision gets the next numbered suffix within the 64-char limit (L17).
 */
export function resolveViewId(base: string, taken: ReadonlySet<string>, keepId?: string): string {
  if (base === keepId || !taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type ChartRequirement =
  | { ok: true }
  | { ok: false; reason: "oneDimension" | "twoDimensions" | "exactlyTwoDimensions" | "twoMetrics" };

/** Compatibility between a chart and the metric/dimension counts (S8). */
export function chartRequirement(
  chart: ExplorerChart,
  shape: { metrics: number; dimensions: number },
): ChartRequirement {
  switch (chart) {
    case "heatmap":
      return shape.dimensions === 2 ? { ok: true } : { ok: false, reason: "twoDimensions" };
    case "sankey":
      return shape.dimensions === 2 ? { ok: true } : { ok: false, reason: "exactlyTwoDimensions" };
    case "treemap":
      return shape.dimensions >= 1 ? { ok: true } : { ok: false, reason: "oneDimension" };
    case "scatter":
      return shape.metrics >= 2 ? { ok: true } : { ok: false, reason: "twoMetrics" };
    default:
      return { ok: true };
  }
}

const VL_SCHEMA = "https://vega.github.io/schema/vega-lite/v6.json";
/** Treemap and sankey have no Vega-Lite equivalent: they use Vega specs (L5). */
const VEGA_SCHEMA = "https://vega.github.io/schema/vega/v6.json";

type Json = Record<string, unknown>;

function dimensionChannel(dimension: ExplorerDimension): Json {
  if (dimension === "day") return { field: "day", type: "temporal", timeUnit: "utcyearmonthdate" };
  if (dimension === "hourOfDay" || dimension === "dayOfWeek")
    return { field: dimension, type: "ordinal" };
  return { field: dimension, type: "nominal" };
}

function cartesianSpec(input: {
  chart: ExplorerChart;
  dimensions: ExplorerDimension[];
  metrics: ExplorerMetric[];
}): Json {
  const { chart, dimensions, metrics } = input;
  const [d0, d1] = dimensions;
  const mark =
    chart === "line" ? { type: "line", point: true } : { type: chart === "area" ? "area" : "bar" };
  // With several metrics (or none to place on x), fold them into metric/value rows (L17).
  const fold = metrics.length > 1 || !d0;
  const encoding: Json = {
    x: d0 ? dimensionChannel(d0) : { field: "metric", type: "nominal" },
    y: {
      field: fold ? "value" : metrics[0],
      type: "quantitative",
      ...(chart === "barStacked" ? { stack: "zero" } : {}),
    },
  };
  if (d1) {
    encoding.color = { field: d1, type: "nominal" };
    if (chart === "barGrouped") encoding.xOffset = { field: d1, type: "nominal" };
    if (metrics.length > 1) encoding.column = { field: "metric", type: "nominal" };
  } else if (fold) {
    encoding.color = { field: "metric", type: "nominal" };
  }
  return {
    $schema: VL_SCHEMA,
    data: { name: "table" },
    ...(fold ? { transform: [{ fold: [...metrics], as: ["metric", "value"] }] } : {}),
    mark,
    encoding,
  };
}

function heatmapSpec(dimensions: ExplorerDimension[], metric: ExplorerMetric): Json {
  const [d0, d1] = dimensions as [ExplorerDimension, ExplorerDimension];
  return {
    $schema: VL_SCHEMA,
    data: { name: "table" },
    mark: { type: "rect" },
    encoding: {
      x: dimensionChannel(d0),
      y: dimensionChannel(d1),
      color: { field: metric, type: "quantitative" },
    },
  };
}

function scatterSpec(dimensions: ExplorerDimension[], metrics: ExplorerMetric[]): Json {
  const [m0, m1] = metrics as [ExplorerMetric, ExplorerMetric];
  const [d0] = dimensions;
  return {
    $schema: VL_SCHEMA,
    data: { name: "table" },
    mark: { type: "point", filled: true },
    encoding: {
      x: { field: m0, type: "quantitative" },
      y: { field: m1, type: "quantitative" },
      ...(d0 ? { color: { field: d0, type: "nominal" } } : {}),
    },
  };
}

function treemapSpec(): Json {
  return {
    $schema: VEGA_SCHEMA,
    width: 640,
    height: 360,
    data: [
      {
        name: "tree",
        transform: [
          { type: "stratify", key: "id", parentKey: "parent" },
          {
            type: "treemap",
            field: "value",
            sort: { field: "value", order: "descending" },
            round: true,
            method: "squarify",
            size: [{ signal: "width" }, { signal: "height" }],
          },
        ],
      },
      {
        name: "leaves",
        source: "tree",
        transform: [{ type: "filter", expr: "!datum.children" }],
      },
    ],
    scales: [
      {
        name: "color",
        type: "ordinal",
        range: "category",
        domain: { data: "leaves", field: "group" },
      },
    ],
    marks: [
      {
        type: "rect",
        from: { data: "leaves" },
        encode: {
          update: {
            x: { field: "x0" },
            y: { field: "y0" },
            x2: { field: "x1" },
            y2: { field: "y1" },
            fill: { scale: "color", field: "group" },
          },
        },
      },
      {
        type: "text",
        from: { data: "leaves" },
        encode: {
          update: {
            x: { signal: "datum.x0 + 4" },
            y: { signal: "datum.y0 + 14" },
            limit: { signal: "max(datum.x1 - datum.x0 - 8, 0)" },
            text: { field: "label" },
          },
        },
      },
    ],
  };
}

function sankeySpec(): Json {
  return {
    $schema: VEGA_SCHEMA,
    width: 640,
    height: 360,
    data: [{ name: "nodes" }, { name: "links" }],
    scales: [
      {
        name: "color",
        type: "ordinal",
        range: "category",
        domain: { data: "nodes", field: "label" },
      },
    ],
    marks: [
      {
        type: "path",
        from: { data: "links" },
        encode: {
          enter: { fillOpacity: { value: 0.35 } },
          update: { path: { field: "path" }, fill: { scale: "color", field: "source" } },
        },
      },
      {
        type: "rect",
        from: { data: "nodes" },
        encode: {
          update: {
            x: { field: "x" },
            y: { field: "y0" },
            y2: { field: "y1" },
            width: { value: 12 },
            fill: { scale: "color", field: "label" },
          },
        },
      },
      {
        type: "text",
        from: { data: "nodes" },
        encode: {
          update: {
            x: { signal: "datum.side === 'left' ? 16 : 624" },
            y: { signal: "(datum.y0 + datum.y1) / 2" },
            align: { signal: "datum.side === 'left' ? 'left' : 'right'" },
            baseline: { value: "middle" },
            text: { field: "label" },
          },
        },
      },
    ],
  };
}

/** Spec for the current selection; call chartRequirement first (unmet needs render no chart). */
export function buildChartSpec(input: {
  chart: ExplorerChart;
  dimensions: ExplorerDimension[];
  metrics: ExplorerMetric[];
}): Json {
  const { chart, dimensions, metrics } = input;
  switch (chart) {
    case "heatmap":
      return heatmapSpec(dimensions, metrics[0] as ExplorerMetric);
    case "scatter":
      return scatterSpec(dimensions, metrics);
    case "treemap":
      return treemapSpec();
    case "sankey":
      return sankeySpec();
    default:
      return cartesianSpec(input);
  }
}

export type Row = Record<string, string | number | null>;

function relabeled(row: Row, dimensions: ExplorerDimension[], nullLabel: string): Row {
  const out: Row = { ...row };
  for (const dimension of dimensions) {
    if (out[dimension] === null || out[dimension] === undefined) out[dimension] = nullLabel;
  }
  return out;
}

export interface TreeNode {
  id: string;
  parent?: string | undefined;
  label: string;
  group: string;
  value?: number | undefined;
}

function treeNodes(
  rows: Row[],
  dimensions: ExplorerDimension[],
  metric: ExplorerMetric,
  nullLabel: string,
): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const ensure = (id: string, parent: string | undefined, label: string, group: string) => {
    const existing = nodes.get(id);
    if (existing) return existing;
    const node: TreeNode =
      parent === undefined ? { id, label, group } : { id, parent, label, group };
    nodes.set(id, node);
    return node;
  };
  ensure("root", undefined, "", "");
  for (const row of rows) {
    const path = dimensions.map((dimension) =>
      row[dimension] === null || row[dimension] === undefined ? nullLabel : String(row[dimension]),
    );
    let parent = "root";
    path.forEach((label, depth) => {
      const id = path.slice(0, depth + 1).join("\u0001");
      const leaf = depth === path.length - 1;
      const node = ensure(id, parent, label, path[0] ?? label);
      if (leaf) node.value = (node.value ?? 0) + (Number(row[metric]) || 0);
      parent = id;
    });
  }
  return [...nodes.values()];
}

export interface SankeyNode {
  label: string;
  side: "left" | "right";
  x: number;
  y0: number;
  y1: number;
}
export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  path: string;
}

const SANKEY_WIDTH = 640;
const SANKEY_HEIGHT = 360;
const SANKEY_NODE_WIDTH = 12;
const SANKEY_GAP = 8;

function ribbon(
  x0: number,
  top0: number,
  bottom0: number,
  x1: number,
  top1: number,
  bottom1: number,
): string {
  const mid = (x0 + x1) / 2;
  const points = [x0, top0, mid, x1, top1, bottom1, bottom0].map((v) => Math.round(v * 100) / 100);
  const [a, t0, m, b, t1, b1, b0] = points as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return `M${a},${t0}C${m},${t0} ${m},${t1} ${b},${t1}L${b},${b1}C${m},${b1} ${m},${b0} ${a},${b0}Z`;
}

/** Two-column flow layout: left column is the first dimension, right column the second. */
function sankeyLayout(
  rows: Row[],
  dimensions: ExplorerDimension[],
  metric: ExplorerMetric,
  nullLabel: string,
): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const [d0, d1] = dimensions as [ExplorerDimension, ExplorerDimension];
  const label = (row: Row, dimension: ExplorerDimension) =>
    row[dimension] === null || row[dimension] === undefined ? nullLabel : String(row[dimension]);
  const links = rows
    .map((row) => ({
      source: label(row, d0),
      target: label(row, d1),
      value: Number(row[metric]) || 0,
    }))
    .filter((link) => link.value > 0);
  const total = links.reduce((sum, link) => sum + link.value, 0);
  if (total <= 0) return { nodes: [], links: [] };

  const columnTotals = (key: "source" | "target") => {
    const totals = new Map<string, number>();
    for (const link of links) totals.set(link[key], (totals.get(link[key]) ?? 0) + link.value);
    return totals;
  };
  const leftTotals = columnTotals("source");
  const rightTotals = columnTotals("target");
  const scale = Math.min(
    (SANKEY_HEIGHT - SANKEY_GAP * (leftTotals.size - 1)) / total,
    (SANKEY_HEIGHT - SANKEY_GAP * (rightTotals.size - 1)) / total,
  );

  const nodes: SankeyNode[] = [];
  const stack = (
    totals: Map<string, number>,
    side: "left" | "right",
    x: number,
  ): Map<string, SankeyNode> => {
    let y = 0;
    const byLabel = new Map<string, SankeyNode>();
    for (const [text, amount] of totals) {
      const node: SankeyNode = { label: text, side, x, y0: y, y1: y + amount * scale };
      y = node.y1 + SANKEY_GAP;
      nodes.push(node);
      byLabel.set(text, node);
    }
    return byLabel;
  };
  const left = stack(leftTotals, "left", 0);
  const right = stack(rightTotals, "right", SANKEY_WIDTH - SANKEY_NODE_WIDTH);

  const used = new Map<string, number>();
  const offset = (node: SankeyNode) => used.get(`${node.side}:${node.label}`) ?? 0;
  const consume = (node: SankeyNode, thickness: number) => {
    const key = `${node.side}:${node.label}`;
    used.set(key, (used.get(key) ?? 0) + thickness);
  };

  const out: SankeyLink[] = [];
  for (const link of links) {
    const source = left.get(link.source) as SankeyNode;
    const target = right.get(link.target) as SankeyNode;
    const thickness = link.value * scale;
    const sy0 = source.y0 + offset(source);
    const ty0 = target.y0 + offset(target);
    consume(source, thickness);
    consume(target, thickness);
    out.push({
      ...link,
      path: ribbon(
        SANKEY_NODE_WIDTH,
        sy0,
        sy0 + thickness,
        SANKEY_WIDTH - SANKEY_NODE_WIDTH,
        ty0,
        ty0 + thickness,
      ),
    });
  }
  return { nodes, links: out };
}

export type DatasetMap = Record<string, readonly object[]>;

export type PreparedData = {
  /** Vega-Lite charts: the rows with null groups labelled. */
  table: Row[];
  /** Treemap: stratified nodes. */
  tree: TreeNode[];
  /** Sankey: precomputed two-column layout. */
  nodes: SankeyNode[];
  links: SankeyLink[];
};

/**
 * Rows → named datasets for the chart. Null dimension groups get the translated label here,
 * at render time; the stored query and spec never see it.
 */
export function prepareData(
  chart: ExplorerChart,
  dimensions: ExplorerDimension[],
  metric: ExplorerMetric,
  rows: Row[],
  nullLabel: string,
): PreparedData {
  const empty: PreparedData = { table: [], tree: [], nodes: [], links: [] };
  if (chart === "treemap")
    return { ...empty, tree: treeNodes(rows, dimensions, metric, nullLabel) };
  if (chart === "sankey") return { ...empty, ...sankeyLayout(rows, dimensions, metric, nullLabel) };
  return { ...empty, table: rows.map((row) => relabeled(row, dimensions, nullLabel)) };
}

/** Deep clone with row values injected into named datasets only; never touches urls (L16). */
export function injectData<T>(spec: T, datasets: DatasetMap): T {
  const clone = structuredClone(spec) as T;
  const put = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) putOne(item);
    } else putOne(entry);
  };
  const putOne = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null) return;
    const data = entry as Record<string, unknown>;
    const name = data.name;
    if (
      typeof name === "string" &&
      datasets[name] &&
      !("url" in data) &&
      !("source" in data) &&
      !("values" in data)
    ) {
      data.values = datasets[name];
    }
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "data") put(value);
      else visit(value);
    }
  };
  visit(clone);
  return clone;
}

export type ChartEncoding = Partial<Record<"x" | "y" | "color" | "size" | "xOffset", string>>;

/** Drops unset channels: the view schema rejects undefined encoding fields. */
function compact(encoding: Record<keyof ChartEncoding, string | undefined>): ChartEncoding {
  const out: ChartEncoding = {};
  for (const [key, value] of Object.entries(encoding) as [
    keyof ChartEncoding,
    string | undefined,
  ][])
    if (value !== undefined) out[key] = value;
  return out;
}

/** Encoding hints for the saved view; every field must reference the query (L16). */
function encodingFor(
  chart: ExplorerChart,
  dimensions: ExplorerDimension[],
  metrics: ExplorerMetric[],
): ChartEncoding {
  const [d0, d1] = dimensions;
  const [m0, m1] = metrics;
  const none = {
    x: undefined,
    y: undefined,
    color: undefined,
    size: undefined,
    xOffset: undefined,
  };
  switch (chart) {
    case "heatmap":
      return compact({ ...none, x: d0, y: d1, color: m0 });
    case "scatter":
      return compact({ ...none, x: m0, y: m1, color: d0 });
    case "treemap":
      return compact({ ...none, color: d0, size: m0 });
    case "sankey":
      return compact({ ...none, x: d0, y: d1, size: m0 });
    default:
      return compact({
        ...none,
        x: d0 ?? m0,
        y: m0,
        color: d1,
        xOffset: chart === "barGrouped" ? d1 : undefined,
      });
  }
}

export function relativeRangeFor(from: string, to: string): RelativeRange | null {
  const days = (Date.parse(to) - Date.parse(from)) / DAY;
  const match = (Object.keys(RELATIVE_RANGES) as RelativeRange[]).find(
    (key) => RELATIVE_RANGES[key] === days,
  );
  return match ?? null;
}

export function viewRangeToPeriod(range: ViewRange, now: number): { from: string; to: string } {
  if (typeof range === "string") {
    const days = RELATIVE_RANGES[range];
    return {
      from: new Date(now - days * DAY).toISOString(),
      to: new Date(now).toISOString(),
    };
  }
  return { from: range.from, to: range.to };
}

export interface SavedViewBody {
  schema: "omt.saved-view/1";
  id: string;
  name: string;
  query: {
    metrics: ExplorerMetric[];
    dimensions: ExplorerDimension[];
    filters: ExplorerFilter[];
    range: ViewRange;
  };
  chart: { type: ExplorerChart; encoding: ChartEncoding };
  spec: Json;
}

/** The PUT /api/views/:id body: the pivot state plus a data-free chart spec (S9, L16). */
export function stateToView(
  state: ExplorerState,
  identity: { id: string; name: string },
): SavedViewBody {
  const range = relativeRangeFor(state.from, state.to) ?? { from: state.from, to: state.to };
  return {
    schema: "omt.saved-view/1",
    id: identity.id,
    name: identity.name,
    query: {
      metrics: [...state.metrics],
      dimensions: [...state.dimensions],
      filters: state.filters.map((filter) => ({ ...filter, values: [...filter.values] })),
      range,
    },
    chart: {
      type: state.chart,
      encoding: encodingFor(state.chart, state.dimensions, state.metrics),
    },
    spec: buildChartSpec(state),
  };
}

const TOKEN_AXIS = "format(datum.value / 1000000, ',.1f') + '\u00a0M'";
const USD_AXIS = "$,.2f";

/**
 * Render-time localization of a Vega-Lite spec: folded metric names become translated labels,
 * channels get translated titles, token axes read in M with one decimal and cost axes in USD
 * (S9, L17). Vega specs (treemap, sankey) carry their labels in the data and are left as is.
 */
export function localizeSpec(
  spec: Json,
  labels: Record<string, string>,
  fold: { key: string; value: string },
): Json {
  if (!String(spec.$schema).includes("/vega-lite/")) return spec;
  const clone = structuredClone(spec);
  const titles: Record<string, string> = { ...labels };
  const kinds = new Map<string, ReturnType<typeof metricKind>>(
    EXPLORER_METRICS.map((metric) => [metric, metricKind(metric)]),
  );
  if (Array.isArray(clone.transform)) {
    const transforms: unknown[] = [];
    for (const transform of clone.transform as unknown[]) {
      transforms.push(transform);
      const { fold: fields, as } = (transform ?? {}) as { fold?: unknown; as?: unknown };
      if (!Array.isArray(fields)) continue;
      const [key = "key", value = "value"] = Array.isArray(as) ? (as as string[]) : [];
      const names = Object.fromEntries(
        fields.map((f) => [String(f), labels[String(f)] ?? String(f)]),
      );
      const datum = `datum[${JSON.stringify(key)}]`;
      transforms.push({ calculate: `${JSON.stringify(names)}[${datum}] || ${datum}`, as: key });
      titles[key] ??= fold.key;
      titles[value] ??= fold.value;
      const folded = new Set(fields.map((f) => kinds.get(String(f))));
      const [only] = folded;
      if (folded.size === 1 && only) kinds.set(value, only);
    }
    clone.transform = transforms;
  }
  const encoding = clone.encoding as Record<string, Record<string, unknown>> | undefined;
  for (const [channel, definition] of Object.entries(encoding ?? {})) {
    const field = definition?.field;
    if (typeof field !== "string") continue;
    if (!("title" in definition) && titles[field]) definition.title = titles[field];
    if ((channel !== "x" && channel !== "y") || "axis" in definition) continue;
    if (kinds.get(field) === "tokens") definition.axis = { labelExpr: TOKEN_AXIS };
    else if (kinds.get(field) === "usd") definition.axis = { format: USD_AXIS };
  }
  return clone;
}

/** How a metric value is formatted in the data table (S9). */
export function metricKind(metric: string): "tokens" | "usd" | "ratio" | "count" {
  switch (metric) {
    case "input":
    case "output":
    case "cacheRead":
    case "cacheWrite":
    case "total":
      return "tokens";
    case "computedCost":
    case "reportedCost":
      return "usd";
    case "cacheHitRatio":
      return "ratio";
    default:
      return "count";
  }
}

/** Comma-separated filter input → contract values: trimmed, unique, 1-256 chars, at most 50. */
export function parseFilterValues(text: string): string[] {
  const values = text
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length >= 1 && value.length <= 256);
  return unique(values).slice(0, 50);
}

/** POST /api/explorer/query response (apps/cli/src/explorer/contract.ts, L16/L17). */
export interface ExplorerResult {
  columns: Array<{ name: string; type: "dimension" | "metric" | "coverage" }>;
  rows: Row[];
  overlapping: boolean;
  truncated: boolean;
}

/** GET /api/views entry: presets carry i18n keys as name/description (L17). */
export interface SavedViewEntry {
  origin: "preset" | "user";
  id: string;
  name: string;
  description?: string | undefined;
  query: {
    metrics: ExplorerMetric[];
    dimensions: ExplorerDimension[];
    filters: ExplorerFilter[];
    range: ViewRange;
  };
  chart: { type: ExplorerChart; encoding: ChartEncoding };
  spec: Json;
}
