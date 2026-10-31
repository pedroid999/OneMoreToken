import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import { FiltersEditor } from "../explorer/FiltersEditor";
import { ResultsTable } from "../explorer/ResultsTable";
import {
  buildChartSpec,
  chartRequirement,
  EXPLORER_CHARTS,
  EXPLORER_DIMENSIONS,
  EXPLORER_METRICS,
  type ExplorerMetric,
  type ExplorerResult,
  type ExplorerState,
  localizeSpec,
  MAX_DIMENSIONS,
  MAX_METRICS,
  parseExplorerState,
  prepareData,
  RELATIVE_RANGES,
  type RelativeRange,
  relativeRangeFor,
  type SavedViewEntry,
  serializeExplorerState,
  viewRangeToPeriod,
} from "../explorer/state";
import { ViewsPanel } from "../explorer/ViewsPanel";
import type { Language } from "../i18n/i18n";
import { useLocation } from "../router";
import "../styles/explorer.css";

// Vega is most of the bundle: load it only when a chart is shown.
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));
const DAY = 86_400_000;

type QueryResult = { body: string; attempt: number; data?: ExplorerResult; failed?: boolean };
type ViewsResult = { views?: SavedViewEntry[]; taken?: Set<string>; failed?: boolean };

const sameList = (a: readonly string[], b: readonly string[]) => a.join(",") === b.join(",");
/** <input type="date"> value of an instant (UTC). */
const dateValue = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Pivot explorer (spec §7.2): metrics × dimensions, filters, free range, charts, saved views. */
export function ExplorerView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const state = useMemo(() => parseExplorerState(search, anchor), [search, anchor]);

  // The URL is the state (spec §8.1): every change is a history entry, like SummaryView.
  const setState = useCallback((next: ExplorerState) => {
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}?${serializeExplorerState(next)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);
  const update = (patch: Partial<ExplorerState>) => setState({ ...state, ...patch });

  // Only the pivot body drives the request; language or theme switches never refetch (S11).
  const body = JSON.stringify({
    metrics: state.metrics,
    dimensions: state.dimensions,
    filters: state.filters,
    from: state.from,
    to: state.to,
  });
  const [result, setResult] = useState<QueryResult>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ body, attempt });
    void fetch("/api/explorer/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("explorer unavailable");
        const data: ExplorerResult = await response.json();
        if (![data?.rows, data?.columns].every(Array.isArray)) throw new Error("bad shape");
        if (!controller.signal.aborted) setResult({ body, attempt, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ body, attempt, failed: true });
      });
    return () => controller.abort();
  }, [body, attempt]);
  const current = result?.body === body && result.attempt === attempt ? result : undefined;
  const data = current?.data;

  const [views, setViews] = useState<ViewsResult>({});
  const [viewsVersion, setViewsVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    if (viewsVersion < 0) return;
    void fetch("/api/views", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("views unavailable");
        const list: { views: SavedViewEntry[]; invalid: { id: string }[] } = await response.json();
        if (!Array.isArray(list?.views) || !Array.isArray(list.invalid))
          throw new Error("bad shape");
        const taken = new Set([...list.views, ...list.invalid].map((view) => view.id));
        if (!controller.signal.aborted) setViews({ views: list.views, taken });
      })
      .catch(() => {
        if (!controller.signal.aborted) setViews({ failed: true });
      });
    return () => controller.abort();
  }, [viewsVersion]);
  const refreshViews = () => setViewsVersion((value) => value + 1);

  const loadView = (view: SavedViewEntry) =>
    setState({
      metrics: [...view.query.metrics],
      dimensions: [...view.query.dimensions],
      filters: view.query.filters.map((filter) => ({ ...filter, values: [...filter.values] })),
      chart: view.chart.type,
      ...viewRangeToPeriod(view.query.range, Date.now()),
      view: view.id,
    });

  const labels = useMemo(
    () =>
      Object.fromEntries([
        ...EXPLORER_METRICS.map((m) => [m, t(`explorer.metric.${m}`)]),
        ...EXPLORER_DIMENSIONS.map((d) => [d, t(`explorer.dimension.${d}`)]),
      ]) as Record<string, string>,
    [t],
  );

  // A loaded view keeps its stored spec while its query and chart are unchanged.
  const loaded = views.views?.find((view) => view.id === state.view);
  const storedSpec =
    loaded &&
    loaded.chart.type === state.chart &&
    sameList(loaded.query.metrics, state.metrics) &&
    sameList(loaded.query.dimensions, state.dimensions)
      ? loaded.spec
      : undefined;
  const specText = JSON.stringify(
    localizeSpec(storedSpec ?? buildChartSpec(state), labels, {
      key: t("explorer.foldKey"),
      value: t("explorer.foldValue"),
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  const noValue = t("explorer.noValue");
  const datasets = useMemo(
    () =>
      data
        ? prepareData(
            state.chart,
            state.dimensions,
            state.metrics[0] as ExplorerMetric,
            data.rows,
            noValue,
          )
        : undefined,
    [data, state.chart, state.dimensions, state.metrics, noValue],
  );
  const requirement = chartRequirement(state.chart, {
    metrics: state.metrics.length,
    dimensions: state.dimensions.length,
  });

  const toggleMetric = (metric: ExplorerMetric) =>
    update({
      metrics: state.metrics.includes(metric)
        ? state.metrics.filter((m) => m !== metric)
        : [...state.metrics, metric],
    });
  const toggleDimension = (dimension: (typeof EXPLORER_DIMENSIONS)[number]) =>
    update({
      dimensions: state.dimensions.includes(dimension)
        ? state.dimensions.filter((d) => d !== dimension)
        : [...state.dimensions, dimension],
    });

  const range = relativeRangeFor(state.from, state.to) ?? "custom";
  const selectRange = (value: RelativeRange | "custom") => {
    if (value === "custom") return;
    update(viewRangeToPeriod(value, Date.now()));
  };
  // The end date is inclusive in the picker and exclusive in the query (L16 half-open bounds).
  const setFrom = (value: string) => {
    const from = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(from) && from < Date.parse(state.to))
      update({ from: new Date(from).toISOString() });
  };
  const setTo = (value: string) => {
    const to = Date.parse(`${value}T00:00:00.000Z`) + DAY;
    if (Number.isFinite(to) && to > Date.parse(state.from))
      update({ to: new Date(to).toISOString() });
  };

  const chartLabel = t("explorer.chartName", { title: t(`explorer.chartType.${state.chart}`) });

  return (
    <>
      <h1 className="view__title">{t("explorer.title")}</h1>
      <div className="explorer__layout">
        <div className="explorer__main">
          <Panel title={t("explorer.configure")}>
            <fieldset className="explorer__group">
              <legend className="explorer__label">{t("explorer.metrics")}</legend>
              <div className="explorer__options">
                {EXPLORER_METRICS.map((metric) => {
                  const selected = state.metrics.includes(metric);
                  return (
                    <Button
                      key={metric}
                      pressed={selected}
                      disabled={
                        selected ? state.metrics.length === 1 : state.metrics.length >= MAX_METRICS
                      }
                      onClick={() => toggleMetric(metric)}
                    >
                      {labels[metric]}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
            <fieldset className="explorer__group">
              <legend className="explorer__label">{t("explorer.dimensions")}</legend>
              <div className="explorer__options">
                {EXPLORER_DIMENSIONS.map((dimension) => {
                  const selected = state.dimensions.includes(dimension);
                  return (
                    <Button
                      key={dimension}
                      pressed={selected}
                      disabled={!selected && state.dimensions.length >= MAX_DIMENSIONS}
                      onClick={() => toggleDimension(dimension)}
                    >
                      {labels[dimension]}
                    </Button>
                  );
                })}
              </div>
            </fieldset>
            <div className="explorer__group">
              <p className="explorer__label">{t("explorer.chart")}</p>
              <SegmentedControl
                label={t("explorer.chart")}
                value={state.chart}
                options={EXPLORER_CHARTS.map((chart) => ({
                  value: chart,
                  label: t(`explorer.chartType.${chart}`),
                }))}
                onChange={(chart) => update({ chart })}
              />
            </div>
            <div className="explorer__group">
              <p className="explorer__label">{t("explorer.range")}</p>
              <div className="explorer__options">
                <SegmentedControl<RelativeRange | "custom">
                  label={t("explorer.range")}
                  value={range}
                  options={[
                    ...(Object.keys(RELATIVE_RANGES) as RelativeRange[]).map((key) => ({
                      value: key,
                      label: t(`explorer.${key}`),
                    })),
                    ...(range === "custom"
                      ? [{ value: "custom" as const, label: t("explorer.customPeriod") }]
                      : []),
                  ]}
                  onChange={selectRange}
                />
                <label className="explorer__field">
                  <span className="explorer__label">{t("explorer.from")}</span>
                  <input
                    type="date"
                    className="explorer__input"
                    value={dateValue(state.from)}
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </label>
                <label className="explorer__field">
                  <span className="explorer__label">{t("explorer.to")}</span>
                  <input
                    type="date"
                    className="explorer__input"
                    value={dateValue(new Date(Date.parse(state.to) - 1).toISOString())}
                    onChange={(event) => setTo(event.target.value)}
                  />
                </label>
              </div>
            </div>
            <div className="explorer__group">
              <p className="explorer__label">{t("explorer.filters")}</p>
              <FiltersEditor filters={state.filters} onChange={(filters) => update({ filters })} />
            </div>
          </Panel>
          <Panel
            title={t("explorer.results")}
            status={
              current?.failed
                ? "error"
                : !data
                  ? "loading"
                  : data.rows.length === 0
                    ? "empty"
                    : "ready"
            }
            error={{ message: t("explorer.error"), onRetry: () => setAttempt((n) => n + 1) }}
            empty={
              <EmptyState
                title={t("explorer.empty.title")}
                body={t("explorer.empty.body")}
                command={t("explorer.empty.command")}
              />
            }
          >
            {data && datasets ? (
              <>
                {data.overlapping ? (
                  <p className="explorer__warning">{t("explorer.overlapping")}</p>
                ) : null}
                {data.truncated ? (
                  <p className="explorer__warning">{t("explorer.truncated")}</p>
                ) : null}
                {requirement.ok ? (
                  <Suspense fallback={<LoadingState />}>
                    <Chart spec={spec} datasets={datasets} label={chartLabel} language={language} />
                  </Suspense>
                ) : (
                  <p className="explorer__warning">
                    {t(`explorer.chartNeeds.${requirement.reason}`)}
                  </p>
                )}
                <ResultsTable data={data} language={language} />
              </>
            ) : null}
          </Panel>
        </div>
        <aside className="explorer__aside">
          <ViewsPanel
            views={views.views}
            takenIds={views.taken ?? new Set()}
            failed={views.failed === true}
            state={state}
            onRetry={() => {
              setViews({});
              refreshViews();
            }}
            onLoad={loadView}
            onSaved={(id) => {
              update({ view: id });
              refreshViews();
            }}
            onDeleted={(id) => {
              if (state.view === id) update({ view: undefined });
              refreshViews();
            }}
          />
        </aside>
      </div>
    </>
  );
}
