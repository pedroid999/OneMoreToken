import type { ReportLanguage } from "./i18n";

// Locale-aware formatting with Intl (spec §8.5), mirroring the dashboard formatters so a report and
// the screen never disagree about a number.

const LOCALES: Record<ReportLanguage, string> = { es: "es-ES", en: "en-US" };
const NBSP = "\u00a0";

const cache = new Map<string, Intl.NumberFormat>();

function numberFormat(
  language: ReportLanguage,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${language}:${JSON.stringify(options)}`;
  let format = cache.get(key);
  if (!format) {
    format = new Intl.NumberFormat(LOCALES[language], options);
    cache.set(key, format);
  }
  return format;
}

/** Millions of tokens with one decimal, the dashboard unit (spec §7.2). */
export function formatTokensM(tokens: number, language: ReportLanguage): string {
  const format = numberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${format.format(tokens / 1_000_000)}${NBSP}M`;
}

export function formatUsd(amount: number, language: ReportLanguage): string {
  return numberFormat(language, { style: "currency", currency: "USD" }).format(amount);
}

/** A ratio such as the cache hit ratio (0..1) with one decimal. */
export function formatPercent(ratio: number, language: ReportLanguage): string {
  return numberFormat(language, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio);
}

/** Percentage points with one decimal; the `pp` unit lives in the catalog. */
export function formatPoints(points: number, language: ReportLanguage): string {
  return numberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(points);
}

/** Counts stay locale-independent so two runs of the same report never differ in separators. */
export function formatCount(value: number): string {
  return String(value);
}

/** UTC instant as `YYYY-MM-DD HH:mm UTC`; stable across locales and platforms. */
export function formatInstant(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
