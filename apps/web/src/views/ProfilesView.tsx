import { type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";
import { Panel } from "../components/Panel";
import { SegmentedControl } from "../components/SegmentedControl";
import { formatNumber, formatTokensM } from "../i18n/format";
import type { Language } from "../i18n/i18n";
import { isProfiles, type ProfileFigures } from "../profiles/contract";
import { costText } from "../profiles/FiguresCells";
import { ProfilePanel } from "../profiles/ProfilePanel";
import { ProfilesComparison } from "../profiles/ProfilesComparison";
import { profilesRequest } from "../profiles/state";
import { parseQuotasPeriod } from "../quotas/state";
import { useJson } from "../quotas/useJson";
import { useLocation } from "../router";
import "../styles/quotas.css";
import "../styles/profiles.css";

const DAY = 86_400_000;

/** gentle-shell turns without a profile: ambiguous or no matching snapshot (spec §6.2). */
function Unattributed({ figures, language }: { figures: ProfileFigures; language: Language }) {
  const { t } = useTranslation();
  return (
    <Panel title={t("profiles.unattributed.title")}>
      {figures.turns === 0 ? (
        <p className="profiles__muted">{t("profiles.unattributed.none")}</p>
      ) : (
        <>
          <p className="profiles__muted">{t("profiles.unattributed.body")}</p>
          <dl className="profiles__facts">
            <div>
              <dt>{t("profiles.column.turns")}</dt>
              <dd>{formatNumber(figures.turns, language)}</dd>
            </div>
            <div>
              <dt>{t("profiles.column.sessions")}</dt>
              <dd>{formatNumber(figures.sessions, language)}</dd>
            </div>
            <div>
              <dt>{t("profiles.column.tokens")}</dt>
              <dd>{formatTokensM(figures.total, language)}</dd>
            </div>
            <div>
              <dt>{t("profiles.column.computedCost")}</dt>
              <dd>{costText(figures.computedCost, language, t("profiles.noCost"))}</dd>
            </div>
          </dl>
        </>
      )}
    </Panel>
  );
}

/** Profiles (spec §7.1 item 5): the §6 comparisons for the selected period (S7). */
export function ProfilesView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const period = useMemo(() => parseQuotasPeriod(search, anchor), [search, anchor]);
  const profiles = useJson(profilesRequest(period), isProfiles);
  const data = profiles.data;

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
  if (profiles.failed) {
    body = <ErrorState message={t("profiles.error")} onRetry={profiles.reload} />;
  } else if (!data) {
    body = <LoadingState />;
  } else if (data.profiles.length === 0 && data.unattributed.turns === 0) {
    body = (
      <EmptyState
        title={t("profiles.empty.title")}
        body={t("profiles.empty.body")}
        command={t("profiles.empty.command")}
      />
    );
  } else {
    body = (
      <>
        {data.profiles.length === 0 ? (
          <EmptyState title={t("profiles.noProfiles.title")} body={t("profiles.noProfiles.body")} />
        ) : (
          <>
            <ProfilesComparison profiles={data.profiles} language={language} />
            {data.profiles.map((profile) => (
              <ProfilePanel key={profile.name} profile={profile} language={language} />
            ))}
          </>
        )}
        <Unattributed figures={data.unattributed} language={language} />
      </>
    );
  }

  return (
    <div className="profiles">
      <h1 className="view__title">{t("profiles.title")}</h1>
      <div className="profiles__toolbar">
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
      <p className="profiles__muted">{t("profiles.intro")}</p>
      {body}
    </div>
  );
}
