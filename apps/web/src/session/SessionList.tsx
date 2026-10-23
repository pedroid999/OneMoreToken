import { useTranslation } from "react-i18next";
import type { SessionList as SessionListData } from "../../../cli/src/sessions/contract";
import { EmptyState } from "../components/EmptyState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { agentLabel, dateTimeFormat } from "./labels";
import { SessionLink } from "./SessionLink";
import {
  listRequest,
  SESSION_AGENTS,
  type SessionAgent,
  type SessionState,
  sessionSearch,
} from "./state";
import { useResource } from "./useResource";

const DAY = 86_400_000;

const isList = (value: unknown): value is SessionListData =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as SessionListData).sessions) &&
  typeof (value as SessionListData).pricing === "object";

/** Changes only URL parameters; navigate() would keep the old query untouched. */
function pushSearch(search: string) {
  window.history.pushState(null, "", `${window.location.pathname}${search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Sessions of the period, newest first, each linked to its detail (L21 UI). */
export function SessionList({ state, language }: { state: SessionState; language: Language }) {
  const { t } = useTranslation();
  const resource = useResource(listRequest(state), isList);
  const data = resource.data;
  const dateFormat = dateTimeFormat(language);
  const noValue = t("session.noValue");

  const duration = Date.parse(state.to) - Date.parse(state.from);
  const period = duration === 30 * DAY ? "30" : duration === 7 * DAY ? "7" : "custom";
  const selectPeriod = (days: string) => {
    if (days === "custom") return;
    const end = Date.now();
    const next = new URLSearchParams(window.location.search);
    next.set("from", new Date(end - Number(days) * DAY).toISOString());
    next.set("to", new Date(end).toISOString());
    pushSearch(`?${next}`);
  };
  const selectAgent = (value: SessionAgent | "all") =>
    pushSearch(
      sessionSearch(window.location.search, { agent: value === "all" ? undefined : value }),
    );
  const computedLabel =
    data?.pricing.basis === "current-reference"
      ? t("session.list.estimatedApiEquivalent")
      : t("session.list.computed");

  return (
    <>
      <div className="session__toolbar">
        <SegmentedControl
          label={t("session.period")}
          value={period}
          options={[
            { value: "7", label: t("summary.last7Days") },
            { value: "30", label: t("summary.last30Days") },
            ...(period === "custom" ? [{ value: "custom", label: t("summary.customPeriod") }] : []),
          ]}
          onChange={selectPeriod}
        />
        <SegmentedControl<SessionAgent | "all">
          label={t("session.agent")}
          value={state.agent ?? "all"}
          options={[
            { value: "all", label: t("session.allAgents") },
            ...SESSION_AGENTS.map((agent) => ({ value: agent, label: agentLabel(t, agent) })),
          ]}
          onChange={selectAgent}
        />
      </div>
      <Panel
        title={t("session.list.title")}
        status={
          resource.failed || resource.notFound
            ? "error"
            : !data
              ? "loading"
              : data.sessions.length === 0
                ? "empty"
                : "ready"
        }
        error={{ message: t("session.list.error"), onRetry: resource.retry }}
        empty={
          <EmptyState
            title={t("session.empty.title")}
            body={t("session.empty.body")}
            command={t("session.empty.command")}
          />
        }
      >
        {data ? (
          <>
            <div className="session__table-wrap">
              <table className="session__table" aria-label={t("session.list.title")}>
                <thead>
                  <tr>
                    <th scope="col">{t("session.list.started")}</th>
                    <th scope="col">{t("session.list.agent")}</th>
                    <th scope="col">{t("session.list.cwd")}</th>
                    <th scope="col">{t("session.list.branch")}</th>
                    <th scope="col" data-numeric="true">
                      {t("session.list.turns")}
                    </th>
                    <th scope="col" data-numeric="true">
                      {t("session.list.tokens")}
                    </th>
                    <th scope="col" data-numeric="true">
                      {computedLabel}
                    </th>
                    <th scope="col" data-numeric="true">
                      {t("session.list.compactions")}
                    </th>
                    <th scope="col" data-numeric="true">
                      {t("session.list.children")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.id}>
                      <th scope="row">
                        <SessionLink patch={{ id: session.id }} className="session__link">
                          <time dateTime={session.startedAt}>
                            {dateFormat.format(new Date(session.startedAt))}
                          </time>
                        </SessionLink>
                      </th>
                      <td>{agentLabel(t, session.agent)}</td>
                      <td>{session.cwd ?? noValue}</td>
                      <td>{session.branch ?? noValue}</td>
                      <td data-numeric="true">{formatNumber(session.turns, language)}</td>
                      <td data-numeric="true">{formatTokensM(session.tokens.total, language)}</td>
                      <td data-numeric="true">
                        {session.costs.computed.usd === null
                          ? t("summary.unknown")
                          : formatUsd(session.costs.computed.usd, language)}
                      </td>
                      <td data-numeric="true">{formatNumber(session.compactions, language)}</td>
                      <td data-numeric="true">{formatNumber(session.children, language)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.truncated ? (
              <p className="session__warning">{t("session.list.truncated")}</p>
            ) : null}
            <p className="session__muted">{t("session.list.scope")}</p>
          </>
        ) : null}
      </Panel>
    </>
  );
}
