import { useTranslation } from "react-i18next";
import { Estimated } from "../components/Estimated";
import { Link } from "../components/Link";
import { Panel } from "../components/Panel";
import { formatPercent } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { isQuotas } from "./contract";
import { PaceText } from "./SubscriptionQuota";
import { quotasRequest, quotaTimeFormat, usageLevel, windowKey } from "./state";
import { useJson } from "./useJson";

/** Summary "estado de cuotas" (spec §7.1 item 1): current window per subscription, estimated. */
export function QuotaStatus({
  from,
  to,
  language,
}: {
  from: string;
  to: string;
  language: Language;
}) {
  const { t } = useTranslation();
  const quotas = useJson(quotasRequest({ from, to }), isQuotas);
  const data = quotas.data;
  const format = quotaTimeFormat(language);
  const open = (
    <Link to="/burn-rate" className="quota__link">
      {t("summary.quota.open")}
    </Link>
  );
  const notice =
    data?.config.status === "missing"
      ? "summary.quota.missing"
      : data?.config.status === "invalid"
        ? "summary.quota.invalid"
        : data?.subscriptions.length === 0
          ? "summary.quota.empty"
          : null;

  return (
    <Panel
      title={t("summary.quota.title")}
      status={quotas.failed ? "error" : !data ? "loading" : "ready"}
      error={{ message: t("summary.quota.error"), onRetry: quotas.reload }}
      actions={open}
    >
      {notice ? (
        <p className={notice === "summary.quota.invalid" ? "quota__warning" : "quota__muted"}>
          {t(notice)}
        </p>
      ) : null}
      {data && !notice
        ? data.subscriptions.map((subscription) => (
            <div key={subscription.id} className="quota__status">
              <h3 className="quota__subtitle">{subscription.label}</h3>
              <dl className="quota__facts">
                {subscription.windows.map((report) => {
                  const pct = report.current?.estimatedPct ?? null;
                  return (
                    <div key={report.kind} data-level={usageLevel(pct)}>
                      <dt>{t(`quota.window.${windowKey(report.kind)}`)}</dt>
                      {report.current ? (
                        <>
                          <dd>
                            {pct === null ? (
                              <span className="quota__muted">
                                {t(`burnRate.limitSource.${report.limitSource}`)}
                              </span>
                            ) : (
                              <Estimated>{formatPercent(pct / 100, language)}</Estimated>
                            )}
                          </dd>
                          {report.resetsAt ? (
                            <dd className="quota__muted">
                              {t("burnRate.gauge.resets", {
                                date: format.format(new Date(report.resetsAt)),
                              })}
                            </dd>
                          ) : null}
                          <dd>
                            <PaceText report={report} language={language} />
                          </dd>
                        </>
                      ) : (
                        <dd className="quota__muted">{t("summary.quota.noWindow")}</dd>
                      )}
                    </div>
                  );
                })}
              </dl>
            </div>
          ))
        : null}
    </Panel>
  );
}
