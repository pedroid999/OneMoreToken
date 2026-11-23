import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { SegmentedControl, type SegmentedOption } from "../components/SegmentedControl";
import { rangeSlug } from "../export/download";
import { formatNumber } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { parseQuotasPeriod } from "../quotas/state";
import { useJson } from "../quotas/useJson";
import { useLocation } from "../router";
import { AgentsComparison } from "./AgentsComparison";
import { isAgentsReport } from "./contract";
import { agentsRequest, type ClassFilter, filterRows } from "./state";
import "../styles/agents.css";

const DAY = 86_400_000;

/** Agents (spec §7.1.6, §7.3): the same task class across agents, derived or corrected (S2, S6). */
export function AgentsView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const [filter, setFilter] = useState<ClassFilter>("all");
  const period = useMemo(() => parseQuotasPeriod(search, anchor), [search, anchor]);
  const report = useJson(agentsRequest(period), isAgentsReport);
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
    body = <ErrorState message={t("agents.error")} onRetry={report.reload} />;
  } else if (!data) {
    body = <LoadingState />;
  } else if (data.rows.length === 0) {
    body = (
      <EmptyState
        title={t("agents.empty.title")}
        body={t("agents.empty.body")}
        command={t("agents.empty.command")}
      />
    );
  } else {
    const rows = filterRows(data.rows, filter);
    body = (
      <>
        <p className="agents__headline">
          {t("agents.headline", {
            derived: formatNumber(data.totals.derivedSessions, language),
            corrected: formatNumber(data.totals.correctedSessions, language),
          })}
        </p>
        <AgentsComparison
          rows={rows}
          classes={data.classes}
          language={language}
          filename={`agents-by-task-class-${rangeSlug(period.from, period.to)}`}
        />
      </>
    );
  }

  const classOptions: readonly SegmentedOption<ClassFilter>[] = data
    ? [
        { value: "all", label: t("agents.filter.all") },
        ...data.classes.map((value) => ({ value, label: t(`taskClass.${value}`) })),
      ]
    : [{ value: "all", label: t("agents.filter.all") }];

  return (
    <div className="agents">
      <h1 className="view__title">{t("agents.title")}</h1>
      <div className="agents__toolbar">
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
        {data?.rows.length ? (
          <SegmentedControl
            label={t("agents.filter.label")}
            value={filter}
            options={classOptions}
            onChange={setFilter}
          />
        ) : null}
      </div>
      <p className="agents__muted">{t("agents.intro")}</p>
      {body}
    </div>
  );
}
