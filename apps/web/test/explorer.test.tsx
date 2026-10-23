// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../src/i18n/en.json";
import es from "../src/i18n/es.json";
import { createI18n } from "../src/i18n/i18n";
import { PreferencesProvider } from "../src/prefs/usePreferences";
import { ExplorerView } from "../src/views/ExplorerView";
import { fakeColorScheme, memoryStorage } from "./helpers";

const DAY = 86400000;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-08T00:00:00.000Z";

interface ViewEntry {
  origin: string;
  id: string;
  name: string;
  description?: string;
  query: Record<string, unknown>;
  chart: Record<string, unknown>;
  spec: Record<string, unknown>;
}

const presetSpec = {
  $schema: "https://vega.github.io/schema/vega-lite/v6.json",
  data: { name: "table" },
  mark: { type: "bar" },
  encoding: {
    x: { field: "day", type: "temporal" },
    y: { field: "total", type: "quantitative" },
    color: { field: "agent", type: "nominal" },
  },
};

const preset = (): ViewEntry => ({
  origin: "preset",
  id: "daily-tokens-by-agent",
  name: "explorer.presets.dailyTokensByAgent.name",
  description: "explorer.presets.dailyTokensByAgent.description",
  query: { metrics: ["total"], dimensions: ["day", "agent"], filters: [], range: "last30Days" },
  chart: { type: "barStacked", encoding: { x: "day", y: "total", color: "agent" } },
  spec: presetSpec,
});

const userView = (): ViewEntry => ({
  origin: "user",
  id: "my-view",
  name: "My View",
  query: { metrics: ["turns"], dimensions: ["agent"], filters: [], range: "last7Days" },
  chart: { type: "bar", encoding: { x: "agent", y: "turns" } },
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    mark: { type: "bar" },
    encoding: {
      x: { field: "agent", type: "nominal" },
      y: { field: "turns", type: "quantitative" },
    },
  },
});

const pivot = () => ({
  columns: [
    { name: "day", type: "dimension" },
    { name: "agent", type: "dimension" },
    { name: "total", type: "metric" },
    { name: "computedCost", type: "metric" },
    { name: "computedCostKnown", type: "coverage" },
    { name: "computedCostUnknown", type: "coverage" },
  ],
  rows: [
    {
      day: "2026-01-01",
      agent: "pi",
      total: 1500000,
      computedCost: 12.5,
      computedCostKnown: 2,
      computedCostUnknown: 0,
    },
    {
      day: "2026-01-02",
      agent: null,
      total: 500000,
      computedCost: null,
      computedCostKnown: 0,
      computedCostUnknown: 1,
    },
  ],
  unavailable: [],
  overlapping: false,
  truncated: false,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetcher = vi.fn<typeof fetch>();
let storedViews: ViewEntry[];
let posts: Record<string, unknown>[];

beforeEach(() => {
  window.history.replaceState(
    null,
    "",
    `/explorer?metrics=total%2CcomputedCost&dimensions=day%2Cagent&chart=barStacked&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  storedViews = [preset(), userView()];
  posts = [];
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  fetcher.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/views" && method === "GET") return json({ views: storedViews, invalid: [] });
    if (url === "/api/explorer/query" && method === "POST") {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json(pivot());
    }
    if (url.startsWith("/api/views/") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as ViewEntry;
      storedViews = [...storedViews.filter((v) => v.id !== body.id), { ...body, origin: "user" }];
      return json({ ...body, origin: "user" });
    }
    if (url.startsWith("/api/views/") && method === "DELETE") {
      storedViews = storedViews.filter((v) => v.id !== url.slice("/api/views/".length));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function view(language: "en" | "es" = "en") {
  const i18n = await createI18n({ storage: memoryStorage(), browserLanguages: [language] });
  const scheme = fakeColorScheme(false);
  const utils = render(
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider
        env={{
          storage: memoryStorage(),
          root: document.documentElement,
          matchMedia: scheme.matchMedia,
        }}
      >
        <ExplorerView />
      </PreferencesProvider>
    </I18nextProvider>,
  );
  return { i18n, ...utils };
}

describe("Explorer pivot (S6-S9, L16/L17)", () => {
  it("posts the query and renders tokens in M, USD costs, coverage and no-value cells", async () => {
    await view();
    const table = await screen.findByRole("table", { name: en.explorer.dataTable });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      metrics: ["total", "computedCost"],
      dimensions: ["day", "agent"],
      filters: [],
      from,
      to,
    });
    expect(within(table).getAllByText("1.5 M").length).toBeGreaterThan(0);
    expect(within(table).getByText("$12.50")).toBeTruthy();
    expect(within(table).getByText(en.explorer.unknown)).toBeTruthy();
    expect(within(table).getByText(en.explorer.noValue)).toBeTruthy();
    expect(
      within(table).getByText(
        en.explorer.coverageKnown.replace("{{metric}}", en.explorer.metric.computedCost),
      ),
    ).toBeTruthy();
    expect(
      within(table).getByText(
        en.explorer.coverageUnknown.replace("{{metric}}", en.explorer.metric.computedCost),
      ),
    ).toBeTruthy();
  });

  it("surfaces unavailable dimensions, tool overlap and truncation", async () => {
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/views") return json({ views: storedViews, invalid: [] });
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        ...pivot(),
        unavailable: ["subscription"],
        overlapping: true,
        truncated: true,
      });
    });
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    expect(
      screen.getByText(
        en.explorer.unavailable.replace("{{list}}", en.explorer.dimension.subscription),
      ),
    ).toBeTruthy();
    expect(screen.getByText(en.explorer.overlapping)).toBeTruthy();
    expect(screen.getByText(en.explorer.truncated)).toBeTruthy();
  });

  it("shows why a chart cannot render instead of drawing it (S8)", async () => {
    window.history.replaceState(
      null,
      "",
      `/explorer?metrics=total&dimensions=day&chart=heatmap&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    expect(screen.getByText(en.explorer.chartNeeds.twoDimensions)).toBeTruthy();
  });

  it("renders an empty state with the ingest command when there are no rows", async () => {
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/views") return json({ views: storedViews, invalid: [] });
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ ...pivot(), rows: [] });
    });
    await view();
    expect(await screen.findByText(en.explorer.empty.title)).toBeTruthy();
    expect(screen.getByText(en.explorer.empty.command).tagName).toBe("CODE");
  });

  it("retries after a failed query", async () => {
    let calls = 0;
    fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/views") return json({ views: storedViews, invalid: [] });
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      calls += 1;
      if (calls === 1) throw new Error("down");
      return json(pivot());
    });
    await view();
    expect(await screen.findByText(en.explorer.error)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("table", { name: en.explorer.dataTable })).toBeTruthy();
  });
});

describe("Explorer configuration (S6-S9, S11)", () => {
  it("toggles metrics and dimensions within the contract bounds", async () => {
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    const metrics = screen.getByRole("group", { name: en.explorer.metrics });
    const dimensions = screen.getByRole("group", { name: en.explorer.dimensions });

    fireEvent.click(within(metrics).getByRole("button", { name: en.explorer.metric.computedCost }));
    // Back to the default metric: the URL stays clean, the query keeps ["total"].
    expect(new URLSearchParams(window.location.search).get("metrics")).toBeNull();
    expect(posts.at(-1)?.metrics).toEqual(["total"]);

    fireEvent.click(within(metrics).getByRole("button", { name: en.explorer.metric.reportedCost }));
    expect(new URLSearchParams(window.location.search).get("metrics")).toBe(
      "total%2CreportedCost".replace("%2C", ","),
    );
    fireEvent.click(within(metrics).getByRole("button", { name: en.explorer.metric.input }));
    fireEvent.click(within(metrics).getByRole("button", { name: en.explorer.metric.output }));
    expect(new URLSearchParams(window.location.search).get("metrics")).toBe(
      "total,reportedCost,input,output",
    );
    // Fourth metric selected: the rest are disabled at the 4-metric cap (S6 allows up to 4).
    expect(
      within(metrics)
        .getByRole("button", { name: en.explorer.metric.sessions })
        .getAttribute("disabled"),
    ).not.toBeNull();

    fireEvent.click(within(dimensions).getByRole("button", { name: en.explorer.dimension.day }));
    expect(new URLSearchParams(window.location.search).get("dimensions")).toBe("agent");
    // Two-dimension cap: only the selected ones stay enabled.
    fireEvent.click(within(dimensions).getByRole("button", { name: en.explorer.dimension.model }));
    expect(new URLSearchParams(window.location.search).get("dimensions")).toBe("agent,model");
    expect(
      within(dimensions)
        .getByRole("button", { name: en.explorer.dimension.tool })
        .getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("combines filters and keeps them in the URL (S9)", async () => {
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    fireEvent.click(screen.getByRole("button", { name: en.explorer.addFilter }));
    const values = await screen.findByRole("textbox", { name: en.explorer.filterValues });
    fireEvent.change(values, { target: { value: "pi, claude" } });
    expect(posts.at(-1)?.filters).toEqual([
      { dimension: "agent", op: "in", values: ["pi", "claude"] },
    ]);
    const encoded = new URLSearchParams(window.location.search).get("filters");
    expect(JSON.parse(encoded ?? "")).toEqual([
      { dimension: "agent", op: "in", values: ["pi", "claude"] },
    ]);

    fireEvent.change(screen.getByRole("combobox", { name: en.explorer.filterOperator }), {
      target: { value: "notIn" },
    });
    expect(posts.at(-1)?.filters).toEqual([
      { dimension: "agent", op: "notIn", values: ["pi", "claude"] },
    ]);

    fireEvent.click(screen.getByRole("button", { name: en.explorer.removeFilter }));
    expect(new URLSearchParams(window.location.search).get("filters")).toBeNull();
    expect(posts.at(-1)?.filters).toEqual([]);
  });

  it("offers 7/30/90/365-day ranges plus a free custom range (S9)", async () => {
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    fireEvent.click(screen.getByRole("radio", { name: en.explorer.last30Days }));
    let params = new URLSearchParams(window.location.search);
    const span = Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "");
    expect(span).toBe(30 * DAY);
    expect(posts.at(-1)?.metrics).toEqual(["total", "computedCost"]);

    const fromInput = screen.getByLabelText(en.explorer.from);
    fireEvent.change(fromInput, { target: { value: "2026-01-02" } });
    const toInput = screen.getByLabelText(en.explorer.to);
    fireEvent.change(toInput, { target: { value: "2026-01-05" } });
    params = new URLSearchParams(window.location.search);
    expect(params.get("from")).toBe("2026-01-02T00:00:00.000Z");
    // The end is exclusive: picking the 5th covers the whole day (L16 half-open bounds).
    expect(params.get("to")).toBe("2026-01-06T00:00:00.000Z");
  });

  it("switches language hot, keeping the URL, the view and the metrics (S11)", async () => {
    const { i18n } = await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    const search = window.location.search;
    const calls = posts.length;
    await act(async () => {
      await i18n.changeLanguage("es");
    });
    expect(window.location.search).toBe(search);
    expect(posts.length).toBe(calls);
    expect(screen.getByRole("group", { name: es.explorer.metrics })).toBeTruthy();
    expect(screen.getAllByText("1,5 M").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: es.explorer.presets.dailyTokensByAgent.name }),
    ).toBeTruthy();
  });
});

describe("Explorer saved views (S9, S13, L2)", () => {
  it("loads a preset: applies its query, range and chart and tags it read-only", async () => {
    window.history.replaceState(null, "", "/explorer");
    await view();
    const button = await screen.findByRole("button", {
      name: en.explorer.presets.dailyTokensByAgent.name,
    });
    fireEvent.click(button);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("view")).toBe("daily-tokens-by-agent");
    expect(params.get("metrics")).toBeNull();
    expect(params.get("dimensions")).toBe("day,agent");
    expect(params.get("chart")).toBe("barStacked");
    const span = Date.parse(params.get("to") ?? "") - Date.parse(params.get("from") ?? "");
    expect(span).toBe(30 * DAY);
    await waitFor(() => expect(posts.at(-1)?.dimensions).toEqual(["day", "agent"]));
    const item = button.closest("li") as HTMLElement;
    expect(within(item).getByText(en.explorer.preset)).toBeTruthy();
    expect(within(item).queryByRole("button", { name: /delete/i })).toBeNull();
    expect(within(item).getByText(en.explorer.presets.dailyTokensByAgent.description)).toBeTruthy();
  });

  it("saves the current state with an id derived from the name and confirms «Vista guardada»", async () => {
    await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    fireEvent.click(screen.getByRole("button", { name: en.explorer.saveView }));
    const name = await screen.findByRole("textbox", { name: en.explorer.viewName });
    fireEvent.change(name, { target: { value: "Mi Vista Ágil" } });
    fetcher.mockClear();
    fireEvent.click(screen.getByRole("button", { name: en.explorer.saveView }));

    const put = fetcher.mock.calls.find(
      ([input, init]) => String(input).startsWith("/api/views/") && init?.method === "PUT",
    );
    expect(put?.[0]).toBe("/api/views/mi-vista-agil");
    const body = JSON.parse(String(put?.[1]?.body)) as Record<string, never>;
    expect(body.schema).toBe("omt.saved-view/1");
    expect(body.id).toBe("mi-vista-agil");
    expect(body.name).toBe("Mi Vista Ágil");
    expect(body.query).toMatchObject({
      metrics: ["total", "computedCost"],
      dimensions: ["day", "agent"],
      range: "last7Days",
    });
    expect(JSON.stringify(body.spec)).not.toContain('"values"');

    expect(await screen.findByText(en.explorer.viewSaved)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("view")).toBe("mi-vista-agil");
    expect(await screen.findByRole("button", { name: "Mi Vista Ágil" })).toBeTruthy();
  });

  it("deletes a user view and refreshes the list", async () => {
    await view();
    const button = await screen.findByRole("button", { name: "My View" });
    const item = button.closest("li") as HTMLElement;
    fireEvent.click(
      within(item).getByRole("button", {
        name: en.explorer.deleteViewNamed.replace("{{name}}", "My View"),
      }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "My View" })).toBeNull());
    expect(
      fetcher.mock.calls.some(
        ([input, init]) => input === "/api/views/my-view" && init?.method === "DELETE",
      ),
    ).toBe(true);
  });
});

describe("Explorer chart (S8: Vega/Vega-Lite with an accessible name)", () => {
  it("renders the chart as an img with a localized name", async () => {
    const { container } = await view();
    await screen.findByRole("table", { name: en.explorer.dataTable });
    const chart = screen.getByRole("img", {
      name: en.explorer.chartName.replace("{{title}}", en.explorer.chartType.barStacked),
    });
    await waitFor(() => expect(chart.querySelector("svg")).not.toBeNull(), { timeout: 5000 });
    expect(container.querySelector(".explorer__chart")).toBe(chart);
  });
});
