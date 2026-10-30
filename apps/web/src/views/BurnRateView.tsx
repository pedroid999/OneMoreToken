import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { SegmentedControl } from "../components/SegmentedControl";
import type { Language } from "../i18n/i18n";
import { isCalibrationList, isQuotas } from "../quotas/contract";
import { SubscriptionQuota } from "../quotas/SubscriptionQuota";
import { parseQuotasPeriod, quotasRequest, SUBSCRIPTIONS_CONFIG_LOCATION } from "../quotas/state";
import { useJson } from "../quotas/useJson";
import { useLocation } from "../router";
import "../styles/quotas.css";

const DAY = 86_400_000;

/** Burn rate (spec §7.1 item 2): quota windows per subscription, pace and calibrations (S3, S4). */
export function BurnRateView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const period = useMemo(() => parseQuotasPeriod(search, anchor), [search, anchor]);
  const quotas = useJson(quotasRequest(period), isQuotas);
  const calibrations = useJson("/api/calibrations", isCalibrationList);
  const data = quotas.data;

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
  const changed = () => {
    quotas.reload();
    calibrations.reload();
  };

  let body: ReactNode;
  if (quotas.failed) {
    body = <ErrorState message={t("burnRate.error")} onRetry={quotas.reload} />;
  } else if (!data) {
    body = <LoadingState />;
  } else if (data.config.status === "missing") {
    body = (
      <EmptyState
        title={t("burnRate.config.missing.title")}
        body={t("burnRate.config.missing.body", { path: SUBSCRIPTIONS_CONFIG_LOCATION })}
      />
    );
  } else if (data.config.status === "invalid") {
    body = (
      <ErrorState
        message={t("burnRate.config.invalid", { path: SUBSCRIPTIONS_CONFIG_LOCATION })}
        onRetry={quotas.reload}
      />
    );
  } else if (data.subscriptions.length === 0) {
    body = (
      <EmptyState
        title={t("burnRate.config.empty.title")}
        body={t("burnRate.config.empty.body", { path: SUBSCRIPTIONS_CONFIG_LOCATION })}
      />
    );
  } else {
    body = data.subscriptions.map((subscription) => (
      <SubscriptionQuota
        key={subscription.id}
        subscription={subscription}
        entries={calibrations.data?.calibrations.filter(
          (entry) => entry.subscriptionId === subscription.id,
        )}
        entriesFailed={calibrations.failed}
        onRetryEntries={calibrations.reload}
        calibrationsInvalid={data.calibrations.status === "invalid"}
        language={language}
        onChanged={changed}
      />
    ));
  }

  return (
    <div className="quota">
      <h1 className="view__title">{t("burnRate.title")}</h1>
      <div className="quota__toolbar">
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
      <p className="quota__muted">{t("burnRate.intro")}</p>
      {body}
    </div>
  );
}
