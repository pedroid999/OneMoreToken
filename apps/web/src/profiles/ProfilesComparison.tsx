import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { usePreferences } from "../prefs/usePreferences";
import { THEME_TOKENS } from "../theme/tokens";
import type { ProfileReport } from "./contract";
import { AttributionText, costText } from "./FiguresCells";
import { comparisonRows, comparisonSpec } from "./state";

// Vega is most of the bundle: load it only when the comparison is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

/** Profiles side by side: cost and tokens, total and per session (spec §6.1). */
export function ProfilesComparison({
  profiles,
  language,
}: {
  profiles: readonly ProfileReport[];
  language: Language;
}) {
  const { t } = useTranslation();
  const { resolvedTheme } = usePreferences();
  const palette = THEME_TOKENS.themes[resolvedTheme].chart;
  const rows = comparisonRows(profiles, palette);
  const rowsText = JSON.stringify(rows);
  const datasets = useMemo(() => ({ table: JSON.parse(rowsText) as object[] }), [rowsText]);
  const specText = JSON.stringify(
    comparisonSpec({
      profile: t("profiles.column.profile"),
      cost: t("profiles.comparison.cost"),
      tokens: t("profiles.comparison.tokens"),
      domain: rows.map((row) => row.profile),
      colors: rows.map((row) => row.color),
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  const noCost = t("profiles.noCost");

  return (
    <Panel title={t("profiles.comparison.title")}>
      <div className="profiles__chart">
        <Suspense fallback={<LoadingState />}>
          <Chart
            spec={spec}
            datasets={datasets}
            label={t("profiles.comparison.chartName")}
            language={language}
          />
        </Suspense>
      </div>
      {/* The table is also the text alternative of the chart (spec §8.4). */}
      <div className="profiles__table-wrap">
        <table className="profiles__table" aria-label={t("profiles.comparison.table")}>
          <thead>
            <tr>
              <th scope="col">{t("profiles.column.profile")}</th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.sessions")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.turns")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.tokens")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.tokensPerSession")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.computedCost")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.costPerSession")}
              </th>
              <th scope="col" data-numeric="true">
                {t("profiles.column.reportedCost")}
              </th>
              <th scope="col">{t("profiles.column.attribution")}</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile, index) => {
              const row = rows[index];
              const totals = profile.totals;
              return (
                <tr key={profile.name}>
                  <th scope="row">{profile.name}</th>
                  <td data-numeric="true">{formatNumber(totals.sessions, language)}</td>
                  <td data-numeric="true">{formatNumber(totals.turns, language)}</td>
                  <td data-numeric="true">{formatTokensM(totals.total, language)}</td>
                  <td data-numeric="true">
                    {row?.tokensPerSession == null
                      ? t("profiles.unknown")
                      : formatTokensM(row.tokensPerSession, language)}
                  </td>
                  <td data-numeric="true">{costText(totals.computedCost, language, noCost)}</td>
                  <td data-numeric="true">
                    {costText(row?.costPerSession ?? null, language, noCost)}
                  </td>
                  <td data-numeric="true">
                    {totals.reportedCost === null
                      ? noCost
                      : formatUsd(totals.reportedCost, language)}
                  </td>
                  <td>
                    <AttributionText figures={totals} language={language} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
