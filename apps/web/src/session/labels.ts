import type { TFunction } from "i18next";
import type { Language } from "../i18n/i18n";

const AGENT_KEYS: Record<string, string> = {
  "claude-code": "claudeCode",
  "gentle-shell": "gentleShell",
  pi: "pi",
  opencode: "opencode",
};
const ROLES = new Set(["user", "assistant", "compaction", "usage"]);

/** Display name of a stored agent id; unknown ids are shown as stored. */
export function agentLabel(t: TFunction, agent: string): string {
  const key = AGENT_KEYS[agent];
  return key ? t(`session.agentName.${key}`) : agent;
}

export function roleLabel(t: TFunction, role: string): string {
  return ROLES.has(role) ? t(`session.role.${role}`) : role;
}

const LOCALES: Record<Language, string> = { es: "es-ES", en: "en-US" };

/** Date and time in UTC, the time zone of every period bound (as in the Summary). */
export function dateTimeFormat(language: Language): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALES[language], {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}
