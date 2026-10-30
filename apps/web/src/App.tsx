import type { i18n as I18n } from "i18next";
import { useLayoutEffect } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { Link } from "./components/Link";
import { StatusBar } from "./components/StatusBar";
import { type AppEnvironment, PreferencesProvider, usePreferences } from "./prefs/usePreferences";
import { matchRoute, navigate, ROUTES, type Route, useLocation } from "./router";
import { AboutView } from "./views/AboutView";
import { BurnRateView } from "./views/BurnRateView";
import { ExplorerView } from "./views/ExplorerView";
import { SessionView } from "./views/SessionView";
import { SettingsView } from "./views/SettingsView";
import { SummaryView } from "./views/SummaryView";
import { UpcomingView } from "./views/UpcomingView";

export interface AppProps {
  i18n: I18n;
  env: AppEnvironment;
}

export function App({ i18n, env }: AppProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <PreferencesProvider env={env}>
        <Shell root={env.root} />
      </PreferencesProvider>
    </I18nextProvider>
  );
}

const VIEW_ROUTES = ROUTES.filter((r) => r.id !== "settings" && r.id !== "about");
const META_ROUTES = ROUTES.filter((r) => r.id === "settings" || r.id === "about");
/** Query parameters that are not filters (`id` selects a session). */
const NON_FILTER_PARAMS = new Set([
  "range",
  "from",
  "to",
  "metrics",
  "dimensions",
  "chart",
  "view",
  "filters",
  "id",
]);

/** Explorer filters ride in a single JSON param; each entry is one filter (spec §7.2). */
function explorerFilterCount(params: URLSearchParams): number {
  const raw = params.get("filters");
  if (!raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function Shell({ root }: { root: HTMLElement }) {
  const { t, i18n } = useTranslation();
  const { theme } = usePreferences();
  const { pathname, search } = useLocation();
  const route = matchRoute(pathname);

  // Unknown or non-canonical paths are rewritten to the view actually shown (spec §8.1).
  useLayoutEffect(() => {
    if (route.path !== pathname) navigate(route.path, { replace: true });
  }, [route.path, pathname]);

  // The language switch is hot: no reload, same route and filters (spec §8.5).
  useLayoutEffect(() => {
    root.setAttribute("lang", i18n.language);
  }, [root, i18n.language]);

  useLayoutEffect(() => {
    document.title = `${t(route.labelKey)} · ${t("app.name")}`;
  }, [t, route.labelKey]);

  const periodParams = new URLSearchParams(search);
  const periodDays =
    (Date.parse(periodParams.get("to") ?? "") - Date.parse(periodParams.get("from") ?? "")) /
    86_400_000;
  const rangeLabel =
    periodDays === 30
      ? t("summary.last30Days")
      : periodParams.has("from") || periodParams.has("to")
        ? periodDays === 7
          ? t("summary.last7Days")
          : t("summary.customPeriod")
        : t("status.rangeLast7Days");
  const searchParams = new URLSearchParams(search);
  const filterCount =
    new Set([...searchParams.keys()].filter((key) => !NON_FILTER_PARAMS.has(key))).size +
    explorerFilterCount(searchParams);

  const navList = (routes: readonly Route[]) => (
    <ul className="sidebar__list">
      {routes.map((r) => (
        <li key={r.id}>
          <Link to={r.path} current={r.id === route.id} className="sidebar__link">
            {t(r.labelKey)}
          </Link>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t("a11y.skipToContent")}
      </a>
      <div className="shell__body">
        <nav className="sidebar" aria-label={t("nav.label")}>
          <p className="sidebar__brand">{t("app.name")}</p>
          {navList(VIEW_ROUTES)}
          {navList(META_ROUTES)}
        </nav>
        <main className="main" id="main" tabIndex={-1}>
          <View route={route} />
        </main>
      </div>
      <StatusBar
        segments={[
          { id: "view", content: t(route.labelKey) },
          { id: "range", content: t("status.range", { range: rangeLabel }) },
          { id: "filters", content: t("status.filters", { count: filterCount }) },
          { id: "ingest", content: t("status.ingestIdle") },
          {
            id: "theme",
            content: t("status.theme", { theme: t(`settings.theme.${theme.mode}`) }),
          },
        ]}
      />
    </div>
  );
}

function View({ route }: { route: Route }) {
  switch (route.id) {
    case "summary":
      return <SummaryView />;
    case "burnRate":
      return <BurnRateView />;
    case "explorer":
      return <ExplorerView />;
    case "session":
      return <SessionView />;
    case "settings":
      return <SettingsView />;
    case "about":
      return <AboutView />;
    default:
      return <UpcomingView route={route} />;
  }
}
