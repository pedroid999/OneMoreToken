// Display preferences (spec §8.2, §8.3). parseThemePrefs, resolveTheme and parseDensity are
// serialized into the pre-paint boot script (see boot.ts): keep them self-contained, with no
// references to imports or other module-level bindings.

export const THEME_STORAGE_KEY = "omt.theme";
export const DENSITY_STORAGE_KEY = "omt.density";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const DARK_VARIANTS = ["wave", "dragon"] as const;
export type DarkVariant = (typeof DARK_VARIANTS)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];
export type ResolvedTheme = DarkVariant | "lotus";

export interface ThemePrefs {
  mode: ThemeMode;
  darkVariant: DarkVariant;
}

export const DEFAULT_THEME_PREFS: ThemePrefs = { mode: "system", darkVariant: "wave" };

export function parseThemePrefs(raw: string | null): ThemePrefs {
  let value: unknown = null;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    value = null;
  }
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const mode = record.mode;
  const darkVariant = record.darkVariant;
  return {
    mode: mode === "light" || mode === "dark" ? mode : "system",
    darkVariant: darkVariant === "dragon" ? "dragon" : "wave",
  };
}

/** Lotus is the light theme; the dark one is the chosen variant (spec §8.3). */
export function resolveTheme(prefs: ThemePrefs, prefersDark: boolean): ResolvedTheme {
  const dark = prefs.mode === "dark" || (prefs.mode === "system" && prefersDark);
  return dark ? prefs.darkVariant : "lotus";
}

export function parseDensity(raw: string | null): Density {
  return raw === "compact" ? "compact" : "comfortable";
}
