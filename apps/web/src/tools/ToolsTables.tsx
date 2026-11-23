import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Panel } from "../components/Panel";
import { TableExport } from "../export/TableExport";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { agentLabel } from "../session/labels";
import type { ToolAgentRow, ToolRow } from "./contract";

/** Column header: translation key suffix under `tools.column` and whether it is numeric. */
type Column = readonly [key: string, numeric: boolean];

function Table({
  label,
  columns,
  empty,
  children,
}: {
  label: string;
  columns: readonly Column[];
  empty: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (empty !== null) return <p className="tools__muted">{empty}</p>;
  return (
    <div className="tools__table-wrap">
      <table className="tools__table" aria-label={label}>
        <thead>
          <tr>
            {columns.map(([key, numeric]) => (
              <th key={key} scope="col" data-numeric={numeric || undefined}>
                {t(`tools.column.${key}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const TOOL_COLUMNS: readonly Column[] = [
  ["tool", false],
  ["calls", true],
  ["errors", true],
  ["duration", true],
  ["avgDuration", true],
  ["turns", true],
  ["sharedTurns", true],
  ["tokens", true],
  ["computedCost", true],
  ["reportedCost", true],
];

/** Per-tool figures: calls, errors and durations per call, turns, tokens and cost per turn. */
export function ToolsTable({
  tools,
  language,
  filename,
}: {
  tools: readonly ToolRow[];
  language: Language;
  filename: string;
}) {
  const { t } = useTranslation();
  const title = t("tools.table.title");
  const seconds = (ms: number | null) =>
    ms === null
      ? t("tools.noValue")
      : t("tools.seconds", { value: formatNumber(ms / 1000, language) });
  // An agent without error records leaves the count unknown: never 0, never 0 % (S5).
  const errors = (known: boolean, value: number) =>
    known ? formatNumber(value, language) : t("tools.unknown");
  const usd = (value: number | null) =>
    value === null ? t("tools.noValue") : formatUsd(value, language);

  return (
    <Panel
      title={title}
      actions={
        <TableExport
          name={title}
          filename={filename}
          columns={TOOL_COLUMNS.map(([key]) => t(`tools.column.${key}`))}
          rows={tools.map((tool) => [
            tool.tool,
            tool.calls,
            tool.errorStatusKnown ? tool.errors : null,
            tool.durationKnownMs,
            tool.durationAvgKnownMs,
            tool.turns,
            tool.sharedTurns,
            tool.tokens.total,
            tool.computedCostUsd,
            tool.reportedCostUsd,
          ])}
        />
      }
    >
      <Table
        label={title}
        columns={TOOL_COLUMNS}
        empty={tools.length ? null : t("tools.table.empty")}
      >
        {tools.map((tool) => (
          <tr key={tool.tool}>
            <th scope="row">
              <code>{tool.tool}</code>
            </th>
            <td data-numeric="true">{formatNumber(tool.calls, language)}</td>
            <td data-numeric="true">{errors(tool.errorStatusKnown, tool.errors)}</td>
            <td data-numeric="true">{seconds(tool.durationKnownMs)}</td>
            <td data-numeric="true">{seconds(tool.durationAvgKnownMs)}</td>
            <td data-numeric="true">{formatNumber(tool.turns, language)}</td>
            <td data-numeric="true">{formatNumber(tool.sharedTurns, language)}</td>
            <td data-numeric="true">{formatTokensM(tool.tokens.total, language)}</td>
            <td data-numeric="true">{usd(tool.computedCostUsd)}</td>
            <td data-numeric="true">{usd(tool.reportedCostUsd)}</td>
          </tr>
        ))}
      </Table>
      <p className="tools__muted">{t("tools.errorsUnknownNote")}</p>
    </Panel>
  );
}

const RAW_COLUMNS: readonly Column[] = [
  ["agent", false],
  ["rawName", false],
  ["tool", false],
  ["calls", true],
  ["errors", true],
];

/** The raw name each agent records next to its canonical tool: the mapping, auditable (§7.3). */
export function RawNamesTable({
  rows,
  language,
  filename,
}: {
  rows: readonly ToolAgentRow[];
  language: Language;
  filename: string;
}) {
  const { t } = useTranslation();
  const title = t("tools.raw.title");
  const errors = (known: boolean, value: number) =>
    known ? formatNumber(value, language) : t("tools.unknown");

  return (
    <Panel
      title={title}
      actions={
        <TableExport
          name={title}
          filename={filename}
          columns={RAW_COLUMNS.map(([key]) => t(`tools.column.${key}`))}
          rows={rows.map((row) => [
            row.agent,
            row.rawName,
            row.tool,
            row.calls,
            row.errorStatusKnown ? row.errors : null,
          ])}
        />
      }
    >
      <p className="tools__muted">{t("tools.raw.body")}</p>
      <Table label={title} columns={RAW_COLUMNS} empty={rows.length ? null : t("tools.raw.empty")}>
        {rows.map((row) => (
          // One row per (agent, raw name): the same raw name may repeat per agent only once.
          <tr key={`${row.agent}\u0000${row.rawName}\u0000${row.tool}`}>
            <td>{agentLabel(t, row.agent)}</td>
            <th scope="row">
              <code>{row.rawName}</code>
            </th>
            <td>
              <code>{row.tool}</code>
            </td>
            <td data-numeric="true">{formatNumber(row.calls, language)}</td>
            <td data-numeric="true">{errors(row.errorStatusKnown, row.errors)}</td>
          </tr>
        ))}
      </Table>
    </Panel>
  );
}
