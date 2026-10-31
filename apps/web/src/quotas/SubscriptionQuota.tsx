import { type ReactNode, useId } from "react";
import { useTranslation } from "react-i18next";
import { Estimated } from "../components/Estimated";
import { Panel } from "../components/Panel";
import { formatNumber, formatPercent, formatUsd } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { CalibrationSection } from "./CalibrationSection";
import type { CalibrationEntry, QuotaSubscriptionReport, QuotaWindowKindReport } from "./contract";
import { QuotaTimeline } from "./QuotaTimeline";
import {
  overLimitRows,
  paceOf,
  type QuotasPeriod,
  quotaTimeFormat,
  usageLevel,
  windowKey,
} from "./state";

export interface SubscriptionQuotaProps {
  subscription: QuotaSubscriptionReport;
  entries: CalibrationEntry[] | undefined;
  entriesFailed: boolean;
  onRetryEntries: () => void;
  calibrationsInvalid: boolean;
  language: Language;
  period: QuotasPeriod;
  onChanged: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="quota__section" aria-labelledby={id}>
      <h3 className="quota__subtitle" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Pace projection text of a window kind; every projection is an estimate (S4). */
export function PaceText({
  report,
  language,
}: {
  report: QuotaWindowKindReport;
  language: Language;
}) {
  const { t } = useTranslation();
  const pace = paceOf(report);
  if (pace.kind === "unavailable") {
    return <span className="quota__muted">{t("burnRate.pace.unavailable")}</span>;
  }
  const text =
    pace.kind === "projected"
      ? t("burnRate.pace.projected", {
          time: quotaTimeFormat(language).format(new Date(pace.at)),
        })
      : t(pace.kind === "reached" ? "burnRate.pace.reached" : "burnRate.pace.notBeforeReset");
  return <Estimated>{text}</Estimated>;
}

/** Current window of one kind: gauge, estimated %, reset date and pace (S3). */
function WindowGauge({ report, language }: { report: QuotaWindowKindReport; language: Language }) {
  const { t } = useTranslation();
  const labelId = useId();
  const current = report.current;
  const pct = current?.estimatedPct ?? null;
  return (
    <div className="quota__gauge" data-level={usageLevel(pct)}>
      <p className="quota__gauge-title" id={labelId}>
        {t(`quota.window.${windowKey(report.kind)}`)}
      </p>
      {current ? (
        <>
          {pct === null ? null : (
            <meter
              className="quota__meter"
              aria-labelledby={labelId}
              min={0}
              max={100}
              low={70}
              high={99.99}
              optimum={0}
              value={Math.min(pct, 100)}
            />
          )}
          <p className="quota__figure">
            {pct === null ? (
              <span className="quota__muted">
                {t(`burnRate.limitSource.${report.limitSource}`)}
              </span>
            ) : (
              <Estimated>{formatPercent(pct / 100, language)}</Estimated>
            )}
          </p>
          {report.resetsAt ? (
            <p className="quota__muted">
              {t("burnRate.gauge.resets", {
                date: quotaTimeFormat(language).format(new Date(report.resetsAt)),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="quota__muted">{t("burnRate.windows.noCurrent")}</p>
      )}
      <p className="quota__pace">
        <PaceText report={report} language={language} />
      </p>
      {pct !== null ? (
        <p className="quota__muted">{t(`burnRate.limitSource.${report.limitSource}`)}</p>
      ) : null}
    </div>
  );
}

/** One subscription in Burn rate: windows, timeline, value, over-limit usage and calibration. */
export function SubscriptionQuota(props: SubscriptionQuotaProps) {
  const { subscription, language } = props;
  const { t } = useTranslation();
  const fiveHours = subscription.windows.find((report) => report.kind === "five_hours");
  const value = subscription.extractedValue;
  const over = overLimitRows(subscription);
  const format = quotaTimeFormat(language);

  return (
    <Panel title={subscription.label}>
      <p className="quota__muted">
        {t("burnRate.plan", { plan: subscription.planId, provider: subscription.provider })}
      </p>
      <Section title={t("burnRate.windows.title")}>
        <div className="quota__gauges">
          {subscription.windows.map((report) => (
            <WindowGauge key={report.kind} report={report} language={language} />
          ))}
        </div>
      </Section>
      {fiveHours ? (
        <Section title={t("burnRate.timeline.title")}>
          <QuotaTimeline report={fiveHours} language={language} period={props.period} />
        </Section>
      ) : null}
      <Section title={t("burnRate.value.title")}>
        <dl className="quota__facts">
          <div>
            <dt>{t("burnRate.value.apiEquivalent")}</dt>
            <dd>{formatUsd(value.apiEquivalentUsd, language)}</dd>
          </div>
          <div>
            <dt>{t("burnRate.value.paid")}</dt>
            <dd>
              {value.paidUsd === null
                ? t("burnRate.value.priceUnknown")
                : formatUsd(value.paidUsd, language)}
            </dd>
          </div>
          {value.ratio !== null ? (
            <div>
              <dt>{t("burnRate.value.title")}</dt>
              <dd>{t("burnRate.value.ratio", { ratio: formatNumber(value.ratio, language) })}</dd>
            </div>
          ) : null}
        </dl>
        {value.unpricedTurns > 0 ? (
          <p className="quota__warning">
            {t("burnRate.value.unpriced", {
              count: value.unpricedTurns,
              formatted: formatNumber(value.unpricedTurns, language),
            })}
          </p>
        ) : null}
      </Section>
      <Section title={t("burnRate.overLimit.title")}>
        {over.length === 0 ? (
          <p className="quota__muted">{t("burnRate.overLimit.empty")}</p>
        ) : (
          <div className="quota__table-wrap">
            <table className="quota__table" aria-label={t("burnRate.overLimit.title")}>
              <thead>
                <tr>
                  <th scope="col">{t("burnRate.overLimit.window")}</th>
                  <th scope="col">{t("burnRate.overLimit.period")}</th>
                  <th scope="col" data-numeric="true">
                    {t("burnRate.overLimit.amount")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {over.map((row) => (
                  <tr key={`${row.kind}:${row.startsAt}`}>
                    <td>{t(`quota.window.${windowKey(row.kind)}`)}</td>
                    <td>
                      {t("burnRate.overLimit.range", {
                        from: format.format(new Date(row.startsAt)),
                        to: format.format(new Date(row.endsAt)),
                      })}
                    </td>
                    <td data-numeric="true">
                      <Estimated>{formatUsd(row.overLimitUsd, language)}</Estimated>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      <CalibrationSection
        subscription={subscription}
        entries={props.entries}
        entriesFailed={props.entriesFailed}
        onRetryEntries={props.onRetryEntries}
        invalid={props.calibrationsInvalid}
        language={language}
        onChanged={props.onChanged}
      />
    </Panel>
  );
}
