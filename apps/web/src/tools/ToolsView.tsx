import { lazy, type ReactNode, Suspense, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import type { ChartHandle } from "../explorer/Chart";
import { ChartExport } from "../export/ChartExport";
import { rangeSlug } from "../export/download";
import { formatNumber, formatTokensM } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { usePreferences } from "../prefs/usePreferences";
import { parseQuotasPeriod } from "../quotas/state";
import { useJson } from "../quotas/useJson";
import { useLocation } from "../router";
import { THEME_TOKENS } from "../theme/tokens";
import { isToolsReport, type ToolsReport } from "./contract";
import { dailyRows, dailySpec, toolsRequest, toolsTotals, topTools } from "./state";
import { RawNamesTable, ToolsTable } from "./ToolsTables";
import "../styles/tools.css";

// Vega is most of the bundle: load it only when the chart is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

const DAY = 86_400_000;

/**
 * Daily tokens of the tools that burn the most (spec §7.3: the pace comes from the turn's day,
 * not from the call); the tool table keeps every tool and is its text alternative.
 */
function DailyTokens({
  report,
  language,
  filename,
}: {
  report: ToolsReport;
  language: Language;
  filename: string;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = usePreferences();
  const palette = THEME_TOKENS.themes[resolvedTheme].chart;
  const chart = useRef<ChartHandle | null>(null);
  const tools = topTools(report.daily);
  const rows = dailyRows(report.daily, tools);
  const colors = tools.map((_, index) => palette[index % palette.length] ?? "");
  const rowsText = JSON.stringify(rows);
  const datasets = useMemo(() => ({ table: JSON.parse(rowsText) as object[] }), [rowsText]);
  const specText = JSON.stringify(
    dailySpec({
      day: t("tools.chart.day"),
      tokens: t("tools.chart.tokens"),
      tool: t("tools.chart.tool"),
      tools,
      colors,
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  const title = t("tools.chart.title");
  return (
    <Panel
      title={title}
      actions={rows.length ? <ChartExport chart={chart} name={title} filename={filename} /> : null}
    >
      {rows.length ? (
        <>
          <div className="tools__chart">
            <Suspense fallback={<LoadingState />}>
              <Chart
                chartRef={chart}
                spec={spec}
                datasets={datasets}
                label={t("tools.chart.chartName")}
                language={language}
              />
            </Suspense>
          </div>
          <p className="tools__muted">{t("tools.chart.note", { count: tools.length })}</p>
        </>
      ) : (
        <p className="tools__muted">{t("tools.chart.empty")}</p>
      )}
    </Panel>
  );
}

/** Tools (spec §7.1.8, §7.3): per-call figures next to the overlapping per-turn ones (S3-S7). */
export function ToolsView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const period = useMemo(() => parseQuotasPeriod(search, anchor), [search, anchor]);
  const report = useJson(toolsRequest(period), isToolsReport);
  const data = report.data;

  const duration = Date.parse(period.to) - Date.parse(period.from);
  const selected = duration === 30 * DAY ? "30" : duration === 7 * DAY ? "7" : "custom";
  const select = (days: string) => {
    if (days === "custom") return;
    const end = Date.now();
    const next = new URLSearchParams(window.location.search);
    next.set("from", new Date(end - Number(days) * DAY).toISOString());
    next.set("to", new Date(end).toISOString());
    // Like the Summary: only the period fields of the query change.
    window.history.pushState(null, "", `${window.location.pathname}?${next}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  let body: ReactNode;
  if (report.failed) {
    body = <ErrorState message={t("tools.error")} onRetry={report.reload} />;
  } else if (!data) {
    body = <LoadingState />;
  } else if (data.tools.length === 0) {
    body = (
      <EmptyState
        title={t("tools.empty.title")}
        body={t("tools.empty.body")}
        command={t("tools.empty.command")}
      />
    );
  } else {
    const totals = toolsTotals(data);
    const slug = rangeSlug(period.from, period.to);
    body = (
      <>
        <p className="tools__headline">
          {t("tools.headline", {
            calls: formatNumber(totals.calls, language),
            tools: formatNumber(totals.tools, language),
            tokens: formatTokensM(totals.tokens, language),
          })}
        </p>
        {/* The turn figures of the table overlap: say so before any of them is read (S3). */}
        <p className="tools__warning" role="note">
          {t("tools.overlap")}
        </p>
        <ToolsTable tools={data.tools} language={language} filename={`tools-by-tool-${slug}`} />
        <DailyTokens report={data} language={language} filename={`tools-daily-tokens-${slug}`} />
        <RawNamesTable
          rows={data.byAgent}
          language={language}
          filename={`tools-raw-names-${slug}`}
        />
      </>
    );
  }

  return (
    <div className="tools">
      <h1 className="view__title">{t("tools.title")}</h1>
      <div className="tools__toolbar">
        <SegmentedControl
          label={t("summary.period")}
          value={selected}
          options={[
            { value: "7", label: t("summary.last7Days") },
            { value: "30", label: t("summary.last30Days") },
            ...(selected === "custom"
              ? [{ value: "custom", label: t("summary.customPeriod") }]
              : []),
          ]}
          onChange={select}
        />
      </div>
      <p className="tools__muted">{t("tools.intro")}</p>
      {body}
    </div>
  );
}
