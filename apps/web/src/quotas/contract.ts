// GET /api/quotas and /api/calibrations response shapes (feature doc L7, L8, L11). Mirrors
// QuotaSubscriptionReport in packages/core/src/quota/engine.ts and the Quotas answer of
// apps/cli/src/quotas/service.ts: the web app cannot import them because core pulls in DuckDB.

export type WindowKind = "five_hours" | "weekly" | "monthly";
export type LimitSource = "plan" | "calibrated" | "unknown";
/** Manual readings come from the form; Codex ones are derived from its rate limits, read-only.
 * The API always sends `origin`; the web treats a missing one as manual. */
export type CalibrationOrigin = "manual" | "codex";

export interface QuotaWindow {
  startsAt: string;
  endsAt: string;
  usedUsd: number;
  usedTokens: number;
  limitUsd: number | null;
  limitTokens: number | null;
  estimatedPct: number | null;
  overLimitUsd: number | null;
  limitSource: LimitSource;
  estimated: true;
}

export interface CalibrationReading {
  id: string;
  origin?: CalibrationOrigin;
  observedAt: string;
  observedPct: number;
  usedUsd: number;
  usedTokens: number;
  predictedPct: number | null;
  deltaPct: number | null;
}

export interface QuotaWindowKindReport {
  kind: WindowKind;
  unit: "usd" | "tokens" | "estimated";
  limitSource: LimitSource;
  limitUsd: number | null;
  limitTokens: number | null;
  windows: QuotaWindow[];
  current: QuotaWindow | null;
  resetsAt: string | null;
  projection: { projectedLimitAt: string | null; reached: boolean; estimated: true } | null;
  overLimitUsd: number;
  calibration: { readings: CalibrationReading[]; meanAbsoluteDeviationPct: number | null };
}

export interface QuotaSubscriptionReport {
  id: string;
  planId: string;
  label: string;
  provider: string;
  startedAt: string | null;
  endedAt: string | null;
  monthlyPriceUsd: number | null;
  windows: QuotaWindowKindReport[];
  extractedValue: {
    apiEquivalentUsd: number;
    unpricedTurns: number;
    paidUsd: number | null;
    ratio: number | null;
  };
}

export interface Quotas {
  config: { status: "ok" | "invalid" | "missing" };
  calibrations: { status: "ok" | "invalid" };
  subscriptions: QuotaSubscriptionReport[];
}

export interface CalibrationEntry {
  id: string;
  subscriptionId: string;
  windowKind: WindowKind;
  observedAt: string;
  observedPct: number;
  note?: string;
  origin?: CalibrationOrigin;
}

export interface CalibrationList {
  calibrations: CalibrationEntry[];
}

/** Body of POST /api/calibrations: the entry without its server-assigned id. */
export type CalibrationInput = Omit<CalibrationEntry, "id" | "origin">;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isQuotas = (value: unknown): value is Quotas =>
  record(value) &&
  record(value.config) &&
  record(value.calibrations) &&
  Array.isArray(value.subscriptions) &&
  value.subscriptions.every(
    (subscription) =>
      record(subscription) &&
      Array.isArray(subscription.windows) &&
      record(subscription.extractedValue),
  );

export const isCalibrationList = (value: unknown): value is CalibrationList =>
  record(value) && Array.isArray(value.calibrations);
