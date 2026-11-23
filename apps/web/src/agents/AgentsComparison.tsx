import { lazy, Suspense, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import type { ChartHandle } from "../explorer/Chart";
import { ChartExport } from "../export/ChartExport";
import { TableExport } from "../export/TableExport";
import { formatNumber, formatPercent, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { usePreferences } from "../prefs/usePreferences";
import { agentLabel } from "../session/labels";
import { THEME_TOKENS } from "../theme/tokens";
import type { AgentClassRow, TaskClassValue } from "./contract";
import { agentsIn, chartRows, chartSpec } from "./state";

// Vega is most of the bundle: load it only when the chart is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

/** Column header: translation key suffix under `agents.column` and whether it is numeric. */
type Column = readonly [key: string, numeric: boolean];

const COLUMNS: readonly Column[] = [
  ["taskClass", false],
  ["source", false],
  ["agent", false],
  ["sessions", true],
  ["turns", true],
  ["tokens", true],
  ["computedCost", true],
  ["reportedCost", true],
  ["cacheHitRatio", true],
];

/**
 * The same task class across agents, with derived and corrected sessions apart (spec §7.1.6,
 * §7.3). The table is also the text alternative of the chart (spec §8.4).
 */
export function AgentsComparison({
  rows,
  classes,
  language,
  filename,
}: {
  rows: readonly AgentClassRow[];
  classes: readonly TaskClassValue[];
  language: Language;
  filename: string;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = usePreferences();
  const palette = THEME_TOKENS.themes[resolvedTheme].chart;
  const chart = useRef<ChartHandle | null>(null);
  const title = t("agents.comparison.title");
  const chartTitle = t("agents.chart.title");

  const raw = chartRows(rows, classes);
  const agents = agentsIn(rows)
    .map((agent) => agentLabel(t, agent))
    .sort((a, b) => a.localeCompare(b));
  const colors = agents.map((_, index) => palette[index % palette.length] ?? "");
  const rowsText = JSON.stringify(
    raw.map((row) => ({
      ...row,
      taskClass: t(`taskClass.${row.taskClass}`),
      agent: agentLabel(t, row.agent),
    })),
  );
  const datasets = useMemo(() => ({ table: JSON.parse(rowsText) as object[] }), [rowsText]);
  const specText = JSON.stringify(
    chartSpec({
      taskClass: t("agents.chart.taskClass"),
      agent: t("agents.chart.agent"),
      sessions: t("agents.chart.sessions"),
      turns: t("agents.column.turns"),
      classes: classes.map((value) => t(`taskClass.${value}`)),
      agents,
      colors,
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  const noCost = t("agents.noCost");
  const usd = (value: number | null) => (value === null ? noCost : formatUsd(value, language));
  const ratio = (value: number | null) =>
    value === null ? t("agents.notAvailable") : formatPercent(value, language);

  return (
    <Panel
      title={title}
      actions={
        <>
          <ChartExport chart={chart} name={chartTitle} filename={filename} />
          <TableExport
            name={title}
            filename={filename}
            columns={COLUMNS.map(([key]) => t(`agents.column.${key}`))}
            rows={rows.map((row) => [
              row.taskClass,
              row.source,
              row.agent,
              row.sessions,
              row.turns,
              row.tokens.total,
              row.computedCostUsd,
              row.reportedCostUsd,
              row.cacheHitRatio,
            ])}
          />
        </>
      }
    >
      {rows.length ? (
        <div className="agents__chart">
          <Suspense fallback={<LoadingState />}>
            <Chart
              chartRef={chart}
              spec={spec}
              datasets={datasets}
              label={t("agents.chart.chartName")}
              language={language}
            />
          </Suspense>
        </div>
      ) : (
        <p className="agents__muted">{t("agents.comparison.filtered")}</p>
      )}
      {rows.length ? (
        <div className="agents__table-wrap">
          <table className="agents__table" aria-label={title}>
            <thead>
              <tr>
                {COLUMNS.map(([key, numeric]) => (
                  <th key={key} scope="col" data-numeric={numeric || undefined}>
                    {t(`agents.column.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                // One row per (class, source, agent); the same pair appears once per source.
                <tr key={`${row.taskClass}\u0000${row.source}\u0000${row.agent}`}>
                  <th scope="row">{t(`taskClass.${row.taskClass}`)}</th>
                  <td>{t(`taskClass.source.${row.source}`)}</td>
                  <td>{agentLabel(t, row.agent)}</td>
                  <td data-numeric="true">{formatNumber(row.sessions, language)}</td>
                  <td data-numeric="true">{formatNumber(row.turns, language)}</td>
                  <td data-numeric="true">{formatTokensM(row.tokens.total, language)}</td>
                  <td data-numeric="true">{usd(row.computedCostUsd)}</td>
                  <td data-numeric="true">{usd(row.reportedCostUsd)}</td>
                  <td data-numeric="true">{ratio(row.cacheHitRatio)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
