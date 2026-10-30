import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Estimated } from "../components/Estimated";
import { LoadingState } from "../components/LoadingState";
import { formatPercent } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { usePreferences } from "../prefs/usePreferences";
import type { SemanticColor } from "../theme/tokens";
import { THEME_TOKENS } from "../theme/tokens";
import type { QuotaWindowKindReport } from "./contract";
import {
  quotaTimeFormat,
  timelineRows,
  timelineSpec,
  USAGE_LEVELS,
  type UsageLevel,
} from "./state";

// Vega is most of the bundle: load it only when a timeline is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

/** Level colours are semantic tokens of the active theme (spec §8.2), AA on every surface. */
const LEVEL_COLORS: Record<UsageLevel, SemanticColor> = {
  ok: "success",
  warn: "warning",
  over: "danger",
  unknown: "fg-muted",
};

/** The signature element (spec §8.1): 5 h windows coloured by estimated consumption (S3). */
export function QuotaTimeline({
  report,
  language,
}: {
  report: QuotaWindowKindReport | undefined;
  language: Language;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = usePreferences();
  const rows = timelineRows(report);
  const format = quotaTimeFormat(language);
  const percent = (pct: number | null) =>
    pct === null ? t("burnRate.timeline.unknown") : formatPercent(pct / 100, language);
  const levels = Object.fromEntries(
    USAGE_LEVELS.map((level) => [level, t(`burnRate.level.${level}`)]),
  ) as Record<UsageLevel, string>;

  const chartRows = rows.map((row) => ({
    ...row,
    levelLabel: levels[row.level],
    pctLabel: `${percent(row.pct)} · ${t("quota.estimated")}`,
  }));
  const rowsText = JSON.stringify(chartRows);
  const datasets = useMemo(() => ({ table: JSON.parse(rowsText) as object[] }), [rowsText]);
  const colors = THEME_TOKENS.themes[resolvedTheme].colors;
  const specText = JSON.stringify(
    timelineSpec({
      time: t("burnRate.timeline.time"),
      level: t("burnRate.timeline.level"),
      consumption: t("burnRate.timeline.consumption"),
      levels,
      colors: Object.fromEntries(
        USAGE_LEVELS.map((level) => [level, colors[LEVEL_COLORS[level]]]),
      ) as Record<UsageLevel, string>,
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);

  if (rows.length === 0) return <p className="quota__muted">{t("burnRate.timeline.empty")}</p>;
  return (
    <>
      <div className="quota__chart">
        <Suspense fallback={<LoadingState />}>
          <Chart
            spec={spec}
            datasets={datasets}
            label={t("burnRate.timeline.chartName")}
            language={language}
          />
        </Suspense>
      </div>
      {/* The table is also the text alternative of the timeline (spec §8.4). */}
      <div className="quota__table-wrap">
        <table className="quota__table" aria-label={t("burnRate.timeline.title")}>
          <thead>
            <tr>
              <th scope="col">{t("burnRate.timeline.start")}</th>
              <th scope="col">{t("burnRate.timeline.end")}</th>
              <th scope="col" data-numeric="true">
                {t("burnRate.timeline.consumption")}
              </th>
              <th scope="col">{t("burnRate.timeline.level")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.start} data-level={row.level}>
                <td>
                  <time dateTime={row.start}>{format.format(new Date(row.start))}</time>
                </td>
                <td>
                  <time dateTime={row.end}>{format.format(new Date(row.end))}</time>
                </td>
                <td data-numeric="true">
                  <Estimated>{percent(row.pct)}</Estimated>
                </td>
                <td>
                  <span className="quota__level" data-level={row.level}>
                    {levels[row.level]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
