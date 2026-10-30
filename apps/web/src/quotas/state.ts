// Pure Burn rate state: period, request, usage levels, pace, timeline rows, over-limit usage,
// deviation and calibration form validation (spec §5.2, §5.3; feature doc L8, L11). No React, no
// fetch: every rule is unit-tested.
import type { Language } from "../i18n/i18n";
import type {
  CalibrationInput,
  QuotaSubscriptionReport,
  QuotaWindowKindReport,
  WindowKind,
} from "./contract";

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Same clock skew the server tolerates for `observedAt` (L7). */
const FUTURE_TOLERANCE_MS = 5 * MINUTE;
const NOTE_MAX = 200;

/** Where the local files live (feature doc D1, D2); generic XDG locations, never a user path. */
export const SUBSCRIPTIONS_CONFIG_LOCATION =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion shown to the user
  "${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json";
export const CALIBRATIONS_LOCATION =
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion shown to the user
  "${XDG_DATA_HOME:-~/.local/share}/one-more-token/calibrations.json";

export interface QuotasPeriod {
  from: string;
  to: string;
}

/** Explicit from/to are kept as written (the API validates them), like the Summary. */
export function parseQuotasPeriod(search: string, anchor: number): QuotasPeriod {
  const params = new URLSearchParams(search);
  const explicit = params.has("from") || params.has("to");
  return {
    from: explicit ? (params.get("from") ?? "") : new Date(anchor - 7 * DAY).toISOString(),
    to: explicit ? (params.get("to") ?? "") : new Date(anchor).toISOString(),
  };
}

/** Only the period drives the request; other URL state never refetches. */
export function quotasRequest(period: QuotasPeriod): string {
  return `/api/quotas?${new URLSearchParams({ from: period.from, to: period.to })}`;
}

const WINDOW_KEYS: Record<WindowKind, string> = {
  five_hours: "fiveHours",
  weekly: "weekly",
  monthly: "monthly",
};

/** Catalog key suffix of a window kind (`quota.window.<key>`). */
export function windowKey(kind: WindowKind): string {
  return WINDOW_KEYS[kind];
}

export type UsageLevel = "unknown" | "ok" | "warn" | "over";
export const USAGE_LEVELS: readonly UsageLevel[] = ["ok", "warn", "over", "unknown"];

/** Colour level of an estimated %; unknown when the limit is not known yet. */
export function usageLevel(pct: number | null): UsageLevel {
  if (pct === null) return "unknown";
  if (pct >= 100) return "over";
  return pct >= 70 ? "warn" : "ok";
}

export type Pace =
  | { kind: "unavailable" }
  | { kind: "reached" }
  | { kind: "notBeforeReset" }
  | { kind: "projected"; at: string };

/** Pace projection of the current window; unavailable without one or without a known limit. */
export function paceOf(report: QuotaWindowKindReport): Pace {
  const projection = report.projection;
  if (!projection) return { kind: "unavailable" };
  if (projection.reached) return { kind: "reached" };
  return projection.projectedLimitAt
    ? { kind: "projected", at: projection.projectedLimitAt }
    : { kind: "notBeforeReset" };
}

export interface TimelineRow {
  start: string;
  end: string;
  pct: number | null;
  level: UsageLevel;
}

export function timelineRows(report: QuotaWindowKindReport | undefined): TimelineRow[] {
  return (report?.windows ?? []).map((window) => ({
    start: window.startsAt,
    end: window.endsAt,
    pct: window.estimatedPct,
    level: usageLevel(window.estimatedPct),
  }));
}

export interface OverLimitRow {
  kind: WindowKind;
  startsAt: string;
  endsAt: string;
  overLimitUsd: number;
}

/** Windows with usage beyond their limit (e.g. OpenCode Go paid fallback), newest first. */
export function overLimitRows(subscription: QuotaSubscriptionReport): OverLimitRow[] {
  return subscription.windows
    .flatMap((report) =>
      report.windows.flatMap((window) =>
        window.overLimitUsd !== null && window.overLimitUsd > 0
          ? [
              {
                kind: report.kind,
                startsAt: window.startsAt,
                endsAt: window.endsAt,
                overLimitUsd: window.overLimitUsd,
              },
            ]
          : [],
      ),
    )
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
}

export type Deviation =
  | { kind: "needsMore"; readings: number }
  | { kind: "ready"; meanPct: number };

export function deviationOf(report: QuotaWindowKindReport): Deviation {
  const mean = report.calibration.meanAbsoluteDeviationPct;
  return mean === null
    ? { kind: "needsMore", readings: report.calibration.readings.length }
    : { kind: "ready", meanPct: mean };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `<input type="datetime-local">` value of an instant, in the browser's time zone. */
export function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const LOCALES: Record<Language, string> = { es: "es-ES", en: "en-US" };

/**
 * Window bounds, resets and readings in the browser's time zone with its name, so they match the
 * provider console and the calibration form.
 */
export function quotaTimeFormat(language: Language): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALES[language], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export interface CalibrationDraft {
  windowKind: string;
  observedPct: string;
  /** datetime-local value, local time. */
  observedAt: string;
  note: string;
}

export type CalibrationField = keyof CalibrationDraft;
export type CalibrationErrors = Partial<Record<CalibrationField, string>>;

export type CalibrationValidation =
  | { ok: true; input: CalibrationInput }
  | { ok: false; errors: CalibrationErrors };

const ERRORS = "burnRate.calibration.errors";

/** Mirrors the server rules (L7) so mistakes are explained before anything is sent. */
export function validateCalibration(
  draft: CalibrationDraft,
  context: { subscriptionId: string; kinds: readonly WindowKind[]; now: number },
): CalibrationValidation {
  const errors: CalibrationErrors = {};
  const kind = context.kinds.find((k) => k === draft.windowKind);
  if (!kind) errors.windowKind = `${ERRORS}.windowKind`;

  const text = draft.observedPct.trim().replace(",", ".");
  const pct = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
  if (!(pct >= 0 && pct <= 100)) errors.observedPct = `${ERRORS}.observedPct`;

  const at = draft.observedAt ? new Date(draft.observedAt).getTime() : Number.NaN;
  if (!Number.isFinite(at)) errors.observedAt = `${ERRORS}.observedAt`;
  else if (at > context.now + FUTURE_TOLERANCE_MS) errors.observedAt = `${ERRORS}.observedAtFuture`;

  const note = draft.note.trim();
  if (note.length > NOTE_MAX) errors.note = `${ERRORS}.note`;

  if (!kind || Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    input: {
      subscriptionId: context.subscriptionId,
      windowKind: kind,
      observedAt: new Date(at).toISOString(),
      observedPct: pct,
      ...(note ? { note } : {}),
    },
  };
}

/** Percentage points with one decimal; `signed` shows + and - (calibration deltas). */
export function formatPoints(value: number, language: Language, signed = false): string {
  return new Intl.NumberFormat(LOCALES[language], {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    ...(signed ? { signDisplay: "exceptZero" as const } : {}),
  }).format(value);
}

/** Data-free Vega-Lite spec of the 5 h timeline; rows are injected into `table` at render time. */
export function timelineSpec(labels: {
  time: string;
  level: string;
  consumption: string;
  levels: Record<UsageLevel, string>;
  colors: Record<UsageLevel, string>;
}): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    width: "container",
    height: 64,
    mark: { type: "rect", cornerRadius: 2 },
    encoding: {
      x: { field: "start", type: "temporal", title: labels.time },
      x2: { field: "end" },
      color: {
        field: "levelLabel",
        type: "nominal",
        title: labels.level,
        scale: {
          domain: USAGE_LEVELS.map((level) => labels.levels[level]),
          range: USAGE_LEVELS.map((level) => labels.colors[level]),
        },
        legend: { orient: "bottom" },
      },
      tooltip: [
        { field: "start", type: "temporal", title: labels.time, format: "%c" },
        { field: "pctLabel", type: "nominal", title: labels.consumption },
      ],
    },
  };
}
