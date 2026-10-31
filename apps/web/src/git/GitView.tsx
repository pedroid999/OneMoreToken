import { lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import { formatTokensM } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { parseQuotasPeriod } from "../quotas/state";
import { useJson } from "../quotas/useJson";
import { useLocation } from "../router";
import { type GitCommit, isGitReport } from "./contract";
import { CommitsTable, OrphansTable, PullRequestsTable } from "./GitTables";
import { gitRequest, gitTotals, timelineRows, timelineSpec } from "./state";
import "../styles/git.css";

// Vega is most of the bundle: load it only when the chart is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

const DAY = 86_400_000;

/** Tokens per commit over time; the commits table is its text alternative (spec §8.4). */
function Timeline({ commits, language }: { commits: readonly GitCommit[]; language: Language }) {
  const { t } = useTranslation();
  const rowsText = JSON.stringify(timelineRows(commits));
  const datasets = useMemo(() => ({ table: JSON.parse(rowsText) as object[] }), [rowsText]);
  const specText = JSON.stringify(
    timelineSpec({
      date: t("git.column.date"),
      tokens: t("git.column.tokens"),
      commit: t("git.column.sha"),
      subject: t("git.column.subject"),
    }),
  );
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  return (
    <Panel title={t("git.timeline.title")}>
      <div className="git__chart">
        <Suspense fallback={<LoadingState />}>
          <Chart
            spec={spec}
            datasets={datasets}
            label={t("git.timeline.chartName")}
            language={language}
          />
        </Suspense>
      </div>
    </Panel>
  );
}

/** Git (spec §7.1): tokens per commit, per net line and per PR, and orphan tokens (L20). */
export function GitView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const period = useMemo(() => parseQuotasPeriod(search, anchor), [search, anchor]);
  const report = useJson(gitRequest(period), isGitReport);
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
    body = <ErrorState message={t("git.error")} onRetry={report.reload} />;
  } else if (!data) {
    body = <LoadingState />;
  } else if (data.commits.length === 0 && data.orphanSessions.length === 0) {
    body = (
      <EmptyState
        title={t("git.empty.title")}
        body={t("git.empty.body")}
        command={t("git.empty.command")}
      />
    );
  } else {
    const totals = gitTotals(data);
    body = (
      <>
        <p className="git__headline">
          {t("git.headline", {
            attributed: formatTokensM(totals.attributed, language),
            orphan: formatTokensM(totals.orphan, language),
          })}
        </p>
        {data.commits.length ? <Timeline commits={data.commits} language={language} /> : null}
        <CommitsTable commits={data.commits} language={language} />
        <PullRequestsTable pullRequests={data.pullRequests} language={language} />
        <OrphansTable sessions={data.orphanSessions} language={language} />
      </>
    );
  }

  return (
    <div className="git">
      <h1 className="view__title">{t("git.title")}</h1>
      <div className="git__toolbar">
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
      <p className="git__muted">{t("git.intro")}</p>
      {body}
    </div>
  );
}
