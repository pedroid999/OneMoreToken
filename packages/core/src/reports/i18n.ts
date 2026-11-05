import en from "./i18n/en.json";
import es from "./i18n/es.json";

/** Report language (spec §8.5, §9): the markdown follows the chosen language, never the CLI. */
export type ReportLanguage = "es" | "en";

export const REPORT_LANGUAGES = ["es", "en"] as const;

/** Every key is declared by the English catalog; the Spanish one must declare all of them. */
export type ReportKey = keyof typeof en;

const catalogs = { es, en } satisfies Record<ReportLanguage, Record<ReportKey, string>>;

export function isReportLanguage(value: unknown): value is ReportLanguage {
  return value === "es" || value === "en";
}

/** Replaces `{{vars}}`; an unknown variable stays visible instead of silently disappearing. */
export function t(
  language: ReportLanguage,
  key: ReportKey,
  vars: Record<string, string> = {},
): string {
  return (catalogs[language][key] as string).replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => vars[name] ?? match,
  );
}
