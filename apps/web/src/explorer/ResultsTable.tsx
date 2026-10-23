import { useTranslation } from "react-i18next";
import { formatNumber, formatPercent, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { type ExplorerResult, metricKind } from "./state";

const LOCALES: Record<Language, string> = { es: "es-ES", en: "en-US" };

/** Data table: the text alternative of every chart (spec §8.4) and the exact numbers (S9). */
export function ResultsTable({ data, language }: { data: ExplorerResult; language: Language }) {
  const { t } = useTranslation();
  const locale = LOCALES[language];
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });

  const header = (name: string, type: ExplorerResult["columns"][number]["type"]) => {
    if (type === "dimension") return t(`explorer.dimension.${name}`);
    if (type === "metric") return t(`explorer.metric.${name}`);
    const unknown = name.endsWith("Unknown");
    const metric = t(
      `explorer.metric.${name.slice(0, unknown ? -"Unknown".length : -"Known".length)}`,
    );
    return unknown
      ? t("explorer.coverageUnknown", { metric })
      : t("explorer.coverageKnown", { metric });
  };

  const cell = (name: string, type: string, value: string | number | null | undefined) => {
    if (type === "dimension") {
      if (value === null || value === undefined) return t("explorer.noValue");
      // 2024-01-01 is a Monday: ISO weekday n maps to January n.
      if (name === "dayOfWeek") return weekday.format(Date.UTC(2024, 0, Number(value)));
      if (name === "day") return dayFormat.format(new Date(`${value}T00:00:00Z`));
      return String(value);
    }
    if (value === null || value === undefined) return t("explorer.unknown");
    const number = Number(value);
    if (type === "coverage") return formatNumber(number, language);
    switch (metricKind(name)) {
      case "tokens":
        return formatTokensM(number, language);
      case "usd":
        return formatUsd(number, language);
      case "ratio":
        return formatPercent(number, language);
      default:
        return formatNumber(number, language);
    }
  };

  return (
    <div className="explorer__table-wrap">
      <table className="explorer__table" aria-label={t("explorer.dataTable")}>
        <thead>
          <tr>
            {data.columns.map((column) => (
              <th key={column.name} scope="col" data-type={column.type}>
                {header(column.name, column.type)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => (
            // Rows are a positional snapshot of one response, never reordered in place.
            // biome-ignore lint/suspicious/noArrayIndexKey: groups may share display values
            <tr key={index}>
              {data.columns.map((column) =>
                column.type === "dimension" ? (
                  <th key={column.name} scope="row">
                    {cell(column.name, column.type, row[column.name])}
                  </th>
                ) : (
                  <td key={column.name} data-type={column.type}>
                    {cell(column.name, column.type, row[column.name])}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
