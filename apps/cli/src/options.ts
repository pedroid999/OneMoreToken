import { join } from "node:path";
import { parseArgs } from "node:util";
import { isReportLanguage, type ReportLanguage } from "@omt/core";

/** Not 4317/4318: those are the OpenTelemetry (OTLP) collector ports. */
export const DEFAULT_PORT = 7317;
/** Local only by default (spec §10). */
export const DEFAULT_HOST = "127.0.0.1";
/** Weekly and monthly reports: one pass per hour, cheap and bounded (L27). */
export const DEFAULT_REPORT_INTERVAL_MS = 3_600_000;
/** Threshold alerts share that cadence: a window moves on the hour, so one pass is enough (T7). */
export const DEFAULT_ALERT_INTERVAL_MS = 3_600_000;
/** The dashboard's default language is Spanish; reports follow it unless told otherwise. */
export const DEFAULT_REPORT_LANGUAGE: ReportLanguage = "es";

export interface ServeOptions {
  port: number;
  host: string;
  db: string;
  /** D4 destination of the markdown reports. */
  reportsDirectory: string;
  reportLanguage: ReportLanguage;
  reportIntervalMs: number;
  /** The user's threshold alerts (T7, spec §9). */
  alertsConfigPath: string;
  alertIntervalMs: number;
  /** Telegram credentials: without both of them no channel exists and nothing leaves the machine. */
  telegramBotToken?: string | undefined;
  telegramChatId?: string | undefined;
  help: boolean;
}

export type ParseResult<T> = { ok: true; options: T } | { ok: false; error: string };

function appDataHome(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "one-more-token");
}

/** `$OMT_DB`, else `${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb`. */
export function defaultDatabasePath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.OMT_DB) return env.OMT_DB;
  return join(appDataHome(env, home), "omt.duckdb");
}

/** User saved views: `${XDG_DATA_HOME:-~/.local/share}/one-more-token/views`, whatever `--db` says. */
export function defaultViewsDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return join(appDataHome(env, home), "views");
}

/** Manual quota readings (spec §5.3): `${XDG_DATA_HOME:-~/.local/share}/one-more-token/calibrations.json`. */
export function defaultCalibrationsPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(appDataHome(env, home), "calibrations.json");
}

/** Saved SQL queries: `${XDG_DATA_HOME:-~/.local/share}/one-more-token/sql-views` (T4). */
export function defaultSavedQueriesDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return join(appDataHome(env, home), "sql-views");
}

/** Markdown reports (S6, D4): `${XDG_DATA_HOME:-~/.local/share}/one-more-token/reports`. */
export function defaultReportsDirectory(env: NodeJS.ProcessEnv, home: string): string {
  return join(appDataHome(env, home), "reports");
}

/** The user's subscriptions: `${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json`. */
export function defaultSubscriptionsConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "one-more-token", "subscriptions.json");
}

/** Threshold alerts (T7): beside the subscriptions, because an alert names one of them (spec §9). */
export function defaultAlertsConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "one-more-token", "alerts.json");
}

export function parseServeOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string,
): ParseResult<ServeOptions> {
  let values: {
    port?: string | undefined;
    host?: string | undefined;
    db?: string | undefined;
    "report-lang"?: string | undefined;
    "report-interval-ms"?: string | undefined;
    "alerts-config"?: string | undefined;
    "alert-interval-ms"?: string | undefined;
    "telegram-bot-token"?: string | undefined;
    "telegram-chat-id"?: string | undefined;
  };
  let help = false;
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        db: { type: "string" },
        "report-lang": { type: "string" },
        "report-interval-ms": { type: "string" },
        "alerts-config": { type: "string" },
        "alert-interval-ms": { type: "string" },
        "telegram-bot-token": { type: "string" },
        "telegram-chat-id": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    values = parsed.values;
    help = parsed.values.help ?? false;
  } catch (error) {
    return { ok: false, error: describeParseError(error) };
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) {
      return {
        ok: false,
        error: `invalid --port "${values.port}": expected an integer between 0 and 65535`,
      };
    }
    port = Number(values.port);
  }

  const flag = values["report-lang"];
  const language = flag ?? env.OMT_REPORT_LANGUAGE ?? DEFAULT_REPORT_LANGUAGE;
  if (!isReportLanguage(language)) {
    const source = flag === undefined ? "OMT_REPORT_LANGUAGE" : "--report-lang";
    return { ok: false, error: `invalid ${source} "${language}": expected "es" or "en"` };
  }

  let reportIntervalMs = DEFAULT_REPORT_INTERVAL_MS;
  const interval = values["report-interval-ms"];
  if (interval !== undefined) {
    if (!/^\d+$/.test(interval) || Number(interval) > 86_400_000) {
      return {
        ok: false,
        error: `invalid --report-interval-ms "${interval}": expected an integer between 0 and 86400000`,
      };
    }
    reportIntervalMs = Number(interval);
  }

  let alertIntervalMs = DEFAULT_ALERT_INTERVAL_MS;
  const alertInterval = values["alert-interval-ms"];
  if (alertInterval !== undefined) {
    if (!/^\d+$/.test(alertInterval) || Number(alertInterval) > 86_400_000) {
      return {
        ok: false,
        error: `invalid --alert-interval-ms "${alertInterval}": expected an integer between 0 and 86400000`,
      };
    }
    alertIntervalMs = Number(alertInterval);
  }

  // Credentials are optional: absent or blank means "no channel", never "send anyway".
  const credentials = (flag: string | undefined, name: string): string | undefined => {
    const value = (flag ?? env[name] ?? "").trim();
    return value === "" ? undefined : value;
  };

  return {
    ok: true,
    options: {
      port,
      host: values.host ?? DEFAULT_HOST,
      db: values.db ?? defaultDatabasePath(env, home),
      reportsDirectory: defaultReportsDirectory(env, home),
      reportLanguage: language,
      reportIntervalMs,
      alertsConfigPath: values["alerts-config"] ?? defaultAlertsConfigPath(env, home),
      alertIntervalMs,
      telegramBotToken: credentials(values["telegram-bot-token"], "OMT_TELEGRAM_BOT_TOKEN"),
      telegramChatId: credentials(values["telegram-chat-id"], "OMT_TELEGRAM_CHAT_ID"),
      help,
    },
  };
}

/** Turns `node:util` parseArgs errors into short, stable messages. */
export function describeParseError(error: unknown): string {
  const { code, message } = error as { code?: string; message: string };
  const subject = /'([^']+)'/.exec(message)?.[1] ?? "";
  switch (code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return `unknown option "${subject}"`;
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return `unexpected argument "${subject}"`;
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      return `invalid value for "${subject.split(" ")[0]}": ${message}`;
    default:
      return message;
  }
}
