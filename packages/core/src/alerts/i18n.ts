import type { ReportLanguage } from "../reports/i18n";
import en from "./i18n/en.json";
import es from "./i18n/es.json";

/** Alert language (spec §8.5, §9): the message follows `--report-lang`, like the markdown reports. */
export type AlertKey = keyof typeof en;

const catalogs = { es, en } satisfies Record<ReportLanguage, Record<AlertKey, string>>;

/** Replaces `{{vars}}`; an unknown variable stays visible instead of silently disappearing. */
export function tAlert(
  language: ReportLanguage,
  key: AlertKey,
  vars: Record<string, string> = {},
): string {
  return (catalogs[language][key] as string).replace(
    /\{\{(\w+)\}\}/g,
    (match, name: string) => vars[name] ?? match,
  );
}
