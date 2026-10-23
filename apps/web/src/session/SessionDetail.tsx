import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { SessionDetail as SessionDetailData } from "../../../cli/src/sessions/contract";
import { EmptyState } from "../components/EmptyState";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { formatNumber, formatTokensM, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { agentLabel, dateTimeFormat, roleLabel } from "./labels";
import { SessionLink } from "./SessionLink";
import { contextRows, contextSpec, detailRequest, isSessionId, toolsSummary } from "./state";
import { useResource } from "./useResource";

// Vega is most of the bundle: load it only when the context curve is shown (as in the Explorer).
const Chart = lazy(() => import("../explorer/Chart").then((module) => ({ default: module.Chart })));

const isDetail = (value: unknown): value is SessionDetailData =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as SessionDetailData).session === "object" &&
  Array.isArray((value as SessionDetailData).turns) &&
  Array.isArray((value as SessionDetailData).children) &&
  typeof (value as SessionDetailData).pricing === "object";

/** One session: header, context curve, turns, tools and related sessions (L21 UI). */
export function SessionDetail({ id, language }: { id: string; language: Language }) {
  const { t } = useTranslation();
  const valid = isSessionId(id);
  const resource = useResource(valid ? detailRequest(id) : null, isDetail);
  const data = resource.data;
  const notFound = !valid || resource.notFound;
  const back = (
    <SessionLink patch={{ id: undefined }} className="session__link">
      {t("session.back")}
    </SessionLink>
  );

  return (
    <>
      <p className="session__back">{back}</p>
      <Panel
        title={t("session.detail.overview")}
        status={notFound ? "empty" : resource.failed ? "error" : !data ? "loading" : "ready"}
        error={{ message: t("session.detail.error"), onRetry: resource.retry }}
        empty={
          <EmptyState
            title={t("session.notFound.title")}
            body={t("session.notFound.body")}
            action={back}
          />
        }
      >
        {data ? <Overview data={data} language={language} /> : null}
      </Panel>
      {data && !notFound ? <Sections data={data} language={language} /> : null}
    </>
  );
}

function Overview({ data, language }: { data: SessionDetailData; language: Language }) {
  const { t } = useTranslation();
  const { session } = data;
  const dateFormat = dateTimeFormat(language);
  const noValue = t("session.noValue");
  const fields: [string, string][] = [
    [t("session.detail.agent"), agentLabel(t, session.agent)],
    [t("session.detail.cwd"), session.cwd ?? noValue],
    [t("session.detail.branch"), session.branch ?? noValue],
    [t("session.detail.started"), dateFormat.format(new Date(session.startedAt))],
    [
      t("session.detail.ended"),
      session.endedAt ? dateFormat.format(new Date(session.endedAt)) : noValue,
    ],
  ];
  return (
    <>
      <dl className="session__facts">
        {fields.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="session__total">{formatTokensM(session.tokens.total, language)}</p>
      <p className="session__counts">
        <span>
          {t("summary.turns", {
            count: session.turns,
            formatted: formatNumber(session.turns, language),
          })}
        </span>
        <span>
          {t("session.detail.compactions", {
            count: session.compactions,
            formatted: formatNumber(session.compactions, language),
          })}
        </span>
      </p>
      <dl className="session__facts">
        {(["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => (
          <div key={key}>
            <dt>{t(`summary.tokens.${key}`)}</dt>
            <dd>{formatTokensM(session.tokens[key], language)}</dd>
          </div>
        ))}
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
              {session.costs[key].usd === null
                ? t("summary.unknown")
                : formatUsd(session.costs[key].usd, language)}
            </dd>
            <dd className="session__muted">
              {t(session.costs[key].unknown > 0 ? "summary.coverage" : "summary.completeCoverage", {
                known: formatNumber(session.costs[key].known, language),
                total: formatNumber(session.usageTurns, language),
              })}
            </dd>
          </div>
        ))}
      </dl>
      <p className="session__muted">{t("summary.costNote")}</p>
    </>
  );
}

function Sections({ data, language }: { data: SessionDetailData; language: Language }) {
  const { t } = useTranslation();
  const dateFormat = dateTimeFormat(language);
  const noValue = t("session.noValue");
  const count = (value: number | null) =>
    value === null ? noValue : formatNumber(value, language);
  const usd = (value: number | null) => (value === null ? noValue : formatUsd(value, language));
  const seconds = (ms: number | null) =>
    ms === null ? noValue : t("session.seconds", { value: formatNumber(ms / 1000, language) });

  const rows = useMemo(() => contextRows(data.turns), [data.turns]);
  const datasets = useMemo(() => ({ table: rows }), [rows]);
  const labels = {
    turn: t("session.context.turn"),
    context: t("session.context.size"),
    compaction: t("session.context.compaction"),
  };
  const specText = JSON.stringify(contextSpec(labels));
  const spec = useMemo(() => JSON.parse(specText) as Record<string, unknown>, [specText]);
  const tools = toolsSummary(data.turns);

  return (
    <>
      <Panel title={t("session.context.title")}>
        {rows.some((row) => row.context !== null) ? (
          <div className="session__chart">
            <Suspense fallback={<LoadingState />}>
              <Chart
                spec={spec}
                datasets={datasets}
                label={t("session.context.chartName")}
                language={language}
              />
            </Suspense>
          </div>
        ) : (
          <p className="session__muted">{t("session.context.empty")}</p>
        )}
        <p className="session__muted">{t("session.context.estimate")}</p>
      </Panel>
      <Panel title={t("session.turns.title")}>
        {/* The turn table is also the text alternative of the context curve (spec §8.4). */}
        <div className="session__table-wrap">
          <table className="session__table" aria-label={t("session.turns.title")}>
            <thead>
              <tr>
                {(
                  [
                    ["idx", true],
                    ["role", false],
                    ["time", false],
                    ["model", false],
                    ["effort", false],
                    ["context", true],
                    ["input", true],
                    ["output", true],
                    ["cacheRead", true],
                    ["cacheWrite", true],
                    ["cost", true],
                    ["tools", false],
                  ] as const
                ).map(([key, numeric]) => (
                  <th key={key} scope="col" data-numeric={numeric || undefined}>
                    {t(`session.turns.${key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.turns.map((turn) => (
                <tr key={turn.idx} data-compaction={turn.isCompaction || undefined}>
                  <td data-numeric="true">{formatNumber(turn.idx, language)}</td>
                  <td>{roleLabel(t, turn.role)}</td>
                  <td>
                    <time dateTime={turn.ts}>{dateFormat.format(new Date(turn.ts))}</time>
                  </td>
                  <td>{turn.model ?? noValue}</td>
                  <td>{turn.effort ?? noValue}</td>
                  <td data-numeric="true">{count(turn.contextTokens)}</td>
                  <td data-numeric="true">{count(turn.tokens?.input ?? null)}</td>
                  <td data-numeric="true">{count(turn.tokens?.output ?? null)}</td>
                  <td data-numeric="true">{count(turn.tokens?.cacheRead ?? null)}</td>
                  <td data-numeric="true">{count(turn.tokens?.cacheWrite ?? null)}</td>
                  <td data-numeric="true">{usd(turn.costs.computed)}</td>
                  <td>
                    {turn.tools.length ? (
                      <ul className="session__calls" aria-label={t("session.turns.tools")}>
                        {turn.tools.map((call, index) => (
                          // Calls keep their stored order; the same tool may repeat.
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional snapshot
                          <li key={index} data-status={call.status}>
                            {call.status === "error"
                              ? t("session.turns.toolError", { tool: call.tool })
                              : call.tool}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      noValue
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={t("session.tools.title")}>
        {tools.length ? (
          <div className="session__table-wrap">
            <table className="session__table" aria-label={t("session.tools.title")}>
              <thead>
                <tr>
                  <th scope="col">{t("session.tools.tool")}</th>
                  <th scope="col" data-numeric="true">
                    {t("session.tools.calls")}
                  </th>
                  <th scope="col" data-numeric="true">
                    {t("session.tools.errors")}
                  </th>
                  <th scope="col" data-numeric="true">
                    {t("session.tools.duration")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tools.map((tool) => (
                  <tr key={tool.tool}>
                    <th scope="row">{tool.tool}</th>
                    <td data-numeric="true">{formatNumber(tool.calls, language)}</td>
                    <td data-numeric="true">{formatNumber(tool.errors, language)}</td>
                    <td data-numeric="true">{seconds(tool.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="session__muted">{t("session.tools.empty")}</p>
        )}
      </Panel>
      <Panel title={t("session.related.title")}>
        {!data.parent && data.children.length === 0 ? (
          <p className="session__muted">{t("session.related.none")}</p>
        ) : null}
        {data.parent ? (
          <>
            <h3 className="session__subtitle">{t("session.related.parent")}</h3>
            {data.parent.agent ? (
              <p>
                <SessionLink patch={{ id: data.parent.id }} className="session__link">
                  {agentLabel(t, data.parent.agent)}
                </SessionLink>
              </p>
            ) : (
              <p className="session__muted">{t("session.related.parentMissing")}</p>
            )}
          </>
        ) : null}
        {data.children.length ? (
          <>
            <h3 className="session__subtitle">{t("session.related.children")}</h3>
            <ul className="session__related">
              {data.children.map((child) => (
                <li key={child.id}>
                  <SessionLink patch={{ id: child.id }} className="session__link">
                    {t("session.related.link", {
                      agent: agentLabel(t, child.agent),
                      time: dateFormat.format(new Date(child.startedAt)),
                    })}
                  </SessionLink>
                  <span className="session__muted">
                    {formatTokensM(child.tokens.total, language)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Panel>
      <p className="session__muted">{t("session.detail.commitsLater")}</p>
    </>
  );
}
