import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type { KeyValueStorage } from "../i18n/i18n";
import {
  DENSITY_STORAGE_KEY,
  type Density,
  parseDensity,
  parseThemePrefs,
  type ResolvedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePrefs,
} from "./preferences";

// Live theme and density state (spec §8.2, §8.3). The boot script applied the stored values before
// first paint; this keeps <html> in sync with later choices and with OS color scheme changes.

export interface AppEnvironment {
  storage: KeyValueStorage;
  root: HTMLElement;
  matchMedia: (query: string) => MediaQueryList;
}

export interface Preferences {
  theme: ThemePrefs;
  resolvedTheme: ResolvedTheme;
  density: Density;
  setTheme: (next: ThemePrefs) => void;
  setDensity: (next: Density) => void;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const PreferencesContext = createContext<Preferences | null>(null);

export function PreferencesProvider({
  env,
  children,
}: {
  env: AppEnvironment;
  children: ReactNode;
}) {
  const { storage, root, matchMedia } = env;
  const [theme, setThemeState] = useState(() =>
    parseThemePrefs(storage.getItem(THEME_STORAGE_KEY)),
  );
  const [density, setDensityState] = useState(() =>
    parseDensity(storage.getItem(DENSITY_STORAGE_KEY)),
  );

  const query = useMemo(() => matchMedia(DARK_QUERY), [matchMedia]);
  const subscribe = useCallback(
    (onChange: () => void) => {
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    [query],
  );
  const prefersDark = useSyncExternalStore(subscribe, () => query.matches);
  const resolvedTheme = resolveTheme(theme, prefersDark);

  useLayoutEffect(() => {
    root.setAttribute("data-theme", resolvedTheme);
  }, [root, resolvedTheme]);
  useLayoutEffect(() => {
    root.setAttribute("data-density", density);
  }, [root, density]);

  const value = useMemo<Preferences>(
    () => ({
      theme,
      resolvedTheme,
      density,
      setTheme: (next) => {
        storage.setItem(THEME_STORAGE_KEY, JSON.stringify(next));
        setThemeState(next);
      },
      setDensity: (next) => {
        storage.setItem(DENSITY_STORAGE_KEY, next);
        setDensityState(next);
      },
    }),
    [storage, theme, resolvedTheme, density],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): Preferences {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}
