import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Summary } from "../../../cli/src/summary/contract";
import { EmptyState } from "../components/EmptyState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import { useLocation } from "../router";
import "../styles/summary.css";

const DAY = 86400000;
type Result = { request: string; attempt: number; data?: Summary; failed?: boolean };

export function SummaryView() {
  const { t, i18n } = useTranslation();
  const language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const params = new URLSearchParams(search);
  const explicit = params.has("from") || params.has("to");
  const from = explicit ? (params.get("from") ?? "") : new Date(anchor - 7 * DAY).toISOString();
  const to = explicit ? (params.get("to") ?? "") : new Date(anchor).toISOString();
  // Pass only period parameters; unrelated URL state must not change the request or reset metrics.
  const request = `/api/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const [result, setResult] = useState<Result>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult({ request, attempt });
    void fetch(request, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("summary unavailable");
        const data: Summary = await response.json();
        if (!controller.signal.aborted) setResult({ request, attempt, data });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ request, attempt, failed: true });
      });
    return () => controller.abort();
  }, [request, attempt]);
  const current = result?.request === request && result.attempt === attempt ? result : undefined;
  const data = current?.data;
  const failed = current?.failed;
  const duration = Date.parse(to) - Date.parse(from);
  const selected = duration === 30 * DAY ? "30" : duration === 7 * DAY ? "7" : "custom";
  const select = (days: string) => {
    if (days === "custom") return;
    const end = Date.now();
    const next = new URLSearchParams(window.location.search);
    next.set("from", new Date(end - Number(days) * DAY).toISOString());
    next.set("to", new Date(end).toISOString());
    // navigate() intentionally preserves the old query; this changes only its period fields.
    window.history.pushState(null, "", `${window.location.pathname}?${next}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const locale = language === "es" ? "es-ES" : "en-US";
  const dateFormat = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
  const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const period = data?.period;
  const issues = data ? data.issues.warning + data.issues.error + data.issues.critical : 0;

  return (
    <>
      <h1 className="view__title">{t("summary.title")}</h1>
      <div className="summary__toolbar">
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
        {period ? (
          <p className="summary__period">
            {t("summary.selectedPeriod", {
              from: dateFormat.format(new Date(period.from)),
              to: dateFormat.format(new Date(period.to)),
            })}
          </p>
        ) : null}
      </div>
      <Panel
        title={t("summary.activity")}
        status={failed ? "error" : !data ? "loading" : data.turns === 0 ? "empty" : "ready"}
        error={{ message: t("summary.error"), onRetry: () => setAttempt((value) => value + 1) }}
        empty={
          <EmptyState
            title={t("summary.empty.title")}
            body={t("summary.empty.body")}
            command={t("summary.empty.command")}
          />
        }
      >
        {data ? (
          <>
            <p className="summary__total">{formatTokensM(data.tokens.total, language)}</p>
            <p>
              {t("summary.sessions", {
                count: data.sessions,
                formatted: formatNumber(data.sessions, language),
              })}
            </p>
            <p>
              {t("summary.turns", {
                count: data.turns,
                formatted: formatNumber(data.turns, language),
              })}
            </p>
            <dl className="summary__breakdown">
              {(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => (
                <div key={key}>
                  <dt>{t(`summary.tokens.${key}`)}</dt>
                  <dd>{formatTokensM(data.tokens[key], language)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </Panel>
      {data ? (
        <>
          <Panel title={t("summary.costs")}>
            <dl className="summary__costs">
              {(["reported", "computed"] as const).map((key) => (
                <div key={key}>
                  <dt>
                    {t(
                      key === "computed" && data.pricing.basis === "current-reference"
                        ? "summary.estimatedApiEquivalent"
                        : `summary.${key}`,
                    )}
                  </dt>
                  <dd>
                    {data.costs[key].usd === null
                      ? t("summary.unknown")
                      : formatUsd(data.costs[key].usd, language)}
                  </dd>
                  <dd className="summary__muted">
                    {t(
                      data.costs[key].unknown > 0 ? "summary.coverage" : "summary.completeCoverage",
                      {
                        known: formatNumber(data.costs[key].known, language),
                        total: formatNumber(data.usageTurns, language),
                      },
                    )}
                  </dd>
                </div>
              ))}
            </dl>
            {data.pricing.basis === "current-reference" ? (
              <>
                <p className="summary__muted">
                  {t("summary.referenceDate", {
                    date: dayFormat.format(new Date(`${data.pricing.observedAt}T00:00:00Z`)),
                  })}
                </p>
                <p className="summary__muted">{t("summary.referenceNote")}</p>
                <p className="summary__muted">{t("summary.referenceAssumptions")}</p>
              </>
            ) : null}
            {data.pricing.staleUsageTurns > 0 ? (
              <p className="summary__warning">
                {t("summary.stalePricing", {
                  count: data.pricing.staleUsageTurns,
                  formatted: formatNumber(data.pricing.staleUsageTurns, language),
                })}{" "}
                <code>{t("summary.empty.command")}</code>
              </p>
            ) : null}
            {data.costs.computed.unknown > 0 ? (
              <p className="summary__warning">{t("summary.missingPricing")}</p>
            ) : null}
            <p className="summary__muted">{t("summary.costNote")}</p>
          </Panel>
          {data.turns > 0 ? (
            <Panel title={t("summary.trend")}>
              <table className="summary__trend" aria-label={t("summary.trend")}>
                <thead>
                  <tr>
                    <th scope="col">{t("summary.dayUtc")}</th>
                    <th scope="col">{t("summary.totalTokens")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day) => (
                    <tr key={day.date}>
                      <th scope="row">
                        <time dateTime={day.date}>
                          {dayFormat.format(new Date(`${day.date}T00:00:00Z`))}
                        </time>
                      </th>
                      <td>{formatTokensM(day.tokens, language)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ) : null}
          {issues > 0 ? (
            <p className="summary__warning">
              {t("summary.issues", {
                warning: formatNumber(data.issues.warning, language),
                error: formatNumber(data.issues.error, language),
                critical: formatNumber(data.issues.critical, language),
              })}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="summary__muted">{t("summary.quotaUnavailable")}</p>
    </>
  );
}
