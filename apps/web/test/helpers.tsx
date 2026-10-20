import { render } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../src/i18n/i18n";

export function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

export async function testI18n(language: "es" | "en" = "en"): Promise<I18n> {
  return createI18n({ storage: memoryStorage(), browserLanguages: [language] });
}

export async function renderWithI18n(ui: ReactElement, language: "es" | "en" = "en") {
  const i18n = await testI18n(language);
  return { i18n, ...render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>) };
}

/** A controllable prefers-color-scheme media query. */
export function fakeColorScheme(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  return {
    matchMedia: (() => query) as unknown as (q: string) => MediaQueryList,
    setDark(value: boolean) {
      query.matches = value;
      for (const listener of listeners) listener();
    },
  };
}
