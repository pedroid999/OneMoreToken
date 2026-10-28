import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DATA_DIR } from "./files";

// Explorer pivot vocabulary (spec §7.2). Closed enums: the server maps each name to a fixed SQL
// fragment, so no client text ever reaches a query.
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

export const ExplorerMetricSchema = z.enum(EXPLORER_METRICS);
export const ExplorerDimensionSchema = z.enum(EXPLORER_DIMENSIONS);
export type ExplorerMetric = z.infer<typeof ExplorerMetricSchema>;
export type ExplorerDimension = z.infer<typeof ExplorerDimensionSchema>;

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

export const ExplorerFilterSchema = z
  .object({
    dimension: ExplorerDimensionSchema,
    op: z.enum(["in", "notIn"]),
    values: z.array(z.string().min(1).max(256)).min(1).max(50),
  })
  .strict();
export type ExplorerFilter = z.infer<typeof ExplorerFilterSchema>;

const explorerQueryShape = {
  metrics: z.array(ExplorerMetricSchema).min(1).max(4).refine(unique, "duplicate metric"),
  dimensions: z.array(ExplorerDimensionSchema).max(2).refine(unique, "duplicate dimension"),
  filters: z.array(ExplorerFilterSchema).max(10),
  limit: z.number().int().min(1).max(10000).optional(),
};

/** Request body of POST /api/explorer/query; bounds are validated like the Summary period. */
export const ExplorerQuerySchema = z
  .object({ ...explorerQueryShape, from: z.string(), to: z.string() })
  .strict();
export type ExplorerQuery = z.infer<typeof ExplorerQuerySchema>;

const instant = z.iso.datetime({ offset: true });
export const RELATIVE_RANGES = ["last7Days", "last30Days", "last90Days", "last365Days"] as const;
export const ViewRangeSchema = z.union([
  z.enum(RELATIVE_RANGES),
  z
    .object({ from: instant, to: instant })
    .strict()
    .refine((range) => Date.parse(range.from) < Date.parse(range.to), "from must precede to"),
]);

export const CHART_TYPES = [
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
/** Vega-Lite has no treemap or sankey: those use full Vega specs (L5). */
const VEGA_CHARTS = new Set<string>(["treemap", "sankey"]);
const field = z.string().min(1).max(64);
const SPEC_SCHEMA =
  /^https:\/\/vega\.github\.io\/schema\/(vega-lite|vega)\/v[56](\.\d+){0,2}\.json$/;

const inlineData = (data: unknown): boolean =>
  Array.isArray(data)
    ? data.some(inlineData)
    : data !== null && typeof data === "object" && "values" in data;

/** Data is injected at render time: a stored spec never loads remote or inline data. */
function hasDataSource(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDataSource);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) =>
      key === "url" || (key === "data" && inlineData(child)) || hasDataSource(child),
  );
}

export const SAVED_VIEW_ID = /^[a-z0-9-]{1,64}$/;

export const SavedViewSchema = z
  .object({
    schema: z.literal("omt.saved-view/1"),
    id: z.string().regex(SAVED_VIEW_ID),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500).optional(),
    query: z.object({ ...explorerQueryShape, range: ViewRangeSchema }).strict(),
    chart: z
      .object({
        type: z.enum(CHART_TYPES),
        encoding: z
          .object({ x: field, y: field, color: field, size: field, xOffset: field })
          .partial()
          .strict(),
      })
      .strict(),
    spec: z.looseObject({ $schema: z.string().regex(SPEC_SCHEMA) }),
  })
  .strict()
  .superRefine((view, ctx) => {
    const fields = new Set<string>([...view.query.metrics, ...view.query.dimensions]);
    for (const value of Object.values(view.chart.encoding)) {
      if (value === undefined || !fields.has(value))
        ctx.addIssue({ code: "custom", message: "encoding must reference a query field" });
    }
    const vega = view.spec.$schema.includes("/schema/vega/");
    if (vega !== VEGA_CHARTS.has(view.chart.type)) {
      ctx.addIssue({ code: "custom", message: "treemap and sankey use Vega; others Vega-Lite" });
    }
    if (hasDataSource(view.spec)) {
      ctx.addIssue({ code: "custom", message: "spec must not embed data, urls or values" });
    }
  });
export type SavedView = z.infer<typeof SavedViewSchema>;

const PRESET_KEY = /^explorer\.presets\.[a-zA-Z0-9]+\.(name|description)$/;

/** Versioned presets in data/views (L2): read-only, names are i18n keys, id equals file name. */
export function loadPresetViews(dir = join(DATA_DIR, "views")): SavedView[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const view = SavedViewSchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
      if (`${view.id}.json` !== file)
        throw new Error(`preset id ${view.id} does not match ${file}`);
      for (const key of [view.name, view.description]) {
        if (key !== undefined && !PRESET_KEY.test(key))
          throw new Error(`preset ${view.id} must use explorer.presets.* i18n keys`);
      }
      return view;
    });
}
