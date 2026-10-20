import type { Language } from "./i18n";

// Locale-aware formatting with Intl (spec §8.5). Amounts are in dollars, the unit of the limits.

const LOCALES: Record<Language, string> = { es: "es-ES", en: "en-US" };
const NBSP = "\u00a0";

const cache = new Map<string, Intl.NumberFormat>();
function numberFormat(language: Language, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${language}:${JSON.stringify(options)}`;
  let format = cache.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALES[language], options);
    cache.set(key, format);
  }
  return format;
}

/** Millions of tokens with one decimal, the default unit of the dashboard (spec §7.2). */
export function formatTokensM(tokens: number, language: Language): string {
  const value = numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${value.format(tokens / 1_000_000)}${NBSP}M`;
}

export function formatUsd(amount: number, language: Language): string {
  return numberFormat(language, { style: "currency", currency: "USD" }).format(amount);
}

export function formatNumber(value: number, language: Language): string {
  return numberFormat(language, { maximumFractionDigits: 2 }).format(value);
}

export function formatDateTime(date: Date, language: Language): string {
  return new Intl.DateTimeFormat(LOCALES[language], {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
