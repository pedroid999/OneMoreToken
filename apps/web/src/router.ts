import { useSyncExternalStore } from "react";

// Minimal history-API router: the URL always reflects the current view (spec §8.1).

export type RouteId =
  | "summary"
  | "burnRate"
  | "explorer"
  | "session"
  | "profiles"
  | "agents"
  | "git"
  | "tools"
  | "sql"
  | "settings"
  | "about";

export interface Route {
  id: RouteId;
  path: string;
  /** Translation key of the navigation label. */
  labelKey: string;
  /** Spec §12 phase that delivers the view; undefined when it already exists. */
  phase?: number;
}

export const ROUTES: readonly Route[] = [
  { id: "summary", path: "/", labelKey: "nav.summary" },
  { id: "burnRate", path: "/burn-rate", labelKey: "nav.burnRate", phase: 3 },
  { id: "explorer", path: "/explorer", labelKey: "nav.explorer" },
  { id: "session", path: "/session", labelKey: "nav.session", phase: 2 },
  { id: "profiles", path: "/profiles", labelKey: "nav.profiles", phase: 3 },
  { id: "agents", path: "/agents", labelKey: "nav.agents", phase: 2 },
  { id: "git", path: "/git", labelKey: "nav.git", phase: 4 },
  { id: "tools", path: "/tools", labelKey: "nav.tools", phase: 2 },
  { id: "sql", path: "/sql", labelKey: "nav.sql", phase: 4 },
  { id: "settings", path: "/settings", labelKey: "nav.settings" },
  { id: "about", path: "/about", labelKey: "nav.about" },
];

const SUMMARY = ROUTES[0] as Route;

/** Unknown paths fall back to Summary. */
export function matchRoute(pathname: string): Route {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return ROUTES.find((route) => route.path === normalized) ?? SUMMARY;
}

const NAVIGATE_EVENT = "omt:navigate";

export function navigate(path: string, { replace = false }: { replace?: boolean } = {}): void {
  const url = `${path}${window.location.search}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

/** Current location as "pathname?search", re-rendering on navigation and history moves. */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(
    subscribe,
    () => `${window.location.pathname}${window.location.search}`,
  );
  const url = new URL(href, "http://omt.local");
  return { pathname: url.pathname, search: url.search };
}
