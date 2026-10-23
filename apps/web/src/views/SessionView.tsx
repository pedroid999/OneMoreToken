import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language } from "../i18n/i18n";
import { useLocation } from "../router";
import { SessionDetail } from "../session/SessionDetail";
import { SessionList } from "../session/SessionList";
import { parseSessionState } from "../session/state";
import "../styles/session.css";

/** Session view (spec §7.1, L21): `/session` lists the period, `/session?id=…` shows one. */
export function SessionView() {
  const { t, i18n } = useTranslation();
  const language: Language = i18n.language === "es" ? "es" : "en";
  const { search } = useLocation();
  const [anchor] = useState(() => Date.now());
  const state = useMemo(() => parseSessionState(search, anchor), [search, anchor]);
  return (
    <div className="session">
      <h1 className="view__title">{t("session.title")}</h1>
      {state.id === undefined ? (
        <SessionList state={state} language={language} />
      ) : (
        <SessionDetail id={state.id} language={language} />
      )}
    </div>
  );
}
