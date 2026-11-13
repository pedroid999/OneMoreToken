import type { SubscriptionsFile } from "../data/files";
import type { WindowKind } from "../schema/tables";
import type { CalibrationEntry } from "../subscriptions/calibrations";
import type { UserSubscriptionsFile } from "../subscriptions/config";

/**
 * Pure quota engine (spec §5, design D3): no I/O, every input is passed in. Figures are estimates by
 * nature (spec §5.3), so each window and projection carries `estimated: true`.
 */

const HOUR = 3600000;
const DAY = 24 * HOUR;
/** Average month used to prorate the monthly price over an arbitrary period. */
const AVERAGE_MONTH = (365.25 / 12) * DAY;
const ROLLING: Partial<Record<WindowKind, number>> = { five_hours: 5 * HOUR, weekly: 7 * DAY };

export type UserSubscription = UserSubscriptionsFile["subscriptions"][number];

/** One usage-bearing turn already attributed to a subscription (turn_subscriptions). */
export interface QuotaTurn {
  subscriptionId: string;
  ts: string;
  reportedCostUsd: number | null;
  computedCostUsd: number | null;
  tokens: number;
}

/** Where a calibration reading comes from: the user's form or the provider's own report (D2). */
export type CalibrationOrigin = "manual" | "codex";

/** A % reading reported by the provider inside agent data (Codex `rate_limits`), already
 * attributed to a subscription. `resetsAt` is the provider's end of the window it measures. */
export interface ProviderQuotaReading {
  id: string;
  subscriptionId: string;
  windowKind: "five_hours" | "weekly";
  observedAt: string;
  observedPct: number;
  resetsAt: string;
  origin: Exclude<CalibrationOrigin, "manual">;
}

export interface QuotaInput {
  plans: SubscriptionsFile;
  subscriptions: readonly UserSubscription[];
  turns: readonly QuotaTurn[];
  calibrations: readonly CalibrationEntry[];
  /** Provider readings; reduced to the latest one per window instance (latestProviderReadings). */
  providerReadings?: readonly ProviderQuotaReading[];
  /** Output windows and extracted value are restricted to [from, to). */
  period: { from: string; to: string };
  now: string;
}

export type LimitSource = "plan" | "calibrated" | "unknown";

export interface QuotaWindow {
  startsAt: string;
  endsAt: string;
  usedUsd: number;
  usedTokens: number;
  limitUsd: number | null;
  limitTokens: number | null;
  estimatedPct: number | null;
  /** Usd beyond 100% of a usd limit; null when the limit is unknown or not in usd. */
  overLimitUsd: number | null;
  limitSource: LimitSource;
  estimated: true;
}

export interface CalibrationReading {
  id: string;
  origin: CalibrationOrigin;
  observedAt: string;
  observedPct: number;
  /** Consumption of the window containing the reading, up to the reading. */
  usedUsd: number;
  usedTokens: number;
  /** % predicted with a limit that does not use this reading (leave-one-out). */
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
  calibration: {
    readings: CalibrationReading[];
    /** Mean absolute deviation in percentage points; null without a predicted reading (a calibrated
     * limit needs at least 2 readings, a plan limit 1). */
    meanAbsoluteDeviationPct: number | null;
  };
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
    /** Computed (API price) cost of the attributed turns in the active part of the period. */
    apiEquivalentUsd: number;
    unpricedTurns: number;
    paidUsd: number | null;
    ratio: number | null;
  };
}

type Plan = SubscriptionsFile["plans"][number];
type Unit = QuotaWindowKindReport["unit"];

interface Turn {
  ms: number;
  usd: number;
  tokens: number;
}

interface Span {
  start: number;
  end: number;
  turns: Turn[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const dateMs = (date: string) => Date.parse(`${date}T00:00:00.000Z`);

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** UTC midnight of `anchor` plus `months`, clamping the day to the target month length. */
function addMonths(anchor: number, months: number): number {
  const date = new Date(anchor);
  const target = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(date.getUTCDate(), last));
}

function monthlySpanAt(anchor: number, ms: number): { start: number; end: number } {
  const from = new Date(anchor);
  const at = new Date(ms);
  let n =
    (at.getUTCFullYear() - from.getUTCFullYear()) * 12 + (at.getUTCMonth() - from.getUTCMonth());
  while (addMonths(anchor, n) > ms) n--;
  while (addMonths(anchor, n + 1) <= ms) n++;
  return { start: addMonths(anchor, n), end: addMonths(anchor, n + 1) };
}

/** 5 h and weekly windows open at the first turn after the previous one expired (D3). */
function rollingSpans(turns: readonly Turn[], length: number): Span[] {
  const spans: Span[] = [];
  for (const turn of turns) {
    const last = spans.at(-1);
    if (last && turn.ms < last.end) last.turns.push(turn);
    else spans.push({ start: turn.ms, end: turn.ms + length, turns: [turn] });
  }
  return spans;
}

/** Monthly windows anchor on the subscription start day (D3); the current month exists even empty. */
function monthlySpans(turns: readonly Turn[], anchor: number, now: number, active: boolean) {
  const byStart = new Map<number, Span>();
  const add = (ms: number) => {
    const { start, end } = monthlySpanAt(anchor, ms);
    let span = byStart.get(start);
    if (!span) {
      span = { start, end, turns: [] };
      byStart.set(start, span);
    }
    return span;
  };
  for (const turn of turns) add(turn.ms).turns.push(turn);
  if (active && now >= anchor) add(now);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

function sum(turns: readonly Turn[], until = Number.POSITIVE_INFINITY) {
  let usd = 0;
  let tokens = 0;
  for (const turn of turns) {
    if (turn.ms > until) continue;
    usd += turn.usd;
    tokens += turn.tokens;
  }
  return { usd, tokens };
}

const measure = (unit: Unit, used: { usd: number; tokens: number }) =>
  unit === "tokens" ? used.tokens : used.usd;

function kindReport(
  kind: WindowKind,
  limit: Plan["windows"][number]["limit"],
  turns: readonly Turn[],
  anchor: number,
  activeNow: boolean,
  readingsIn: readonly (CalibrationEntry & { origin: CalibrationOrigin })[],
  from: number,
  to: number,
  now: number,
): QuotaWindowKindReport {
  const unit: Unit = limit.unit;
  const length = ROLLING[kind];
  const spans =
    length === undefined
      ? monthlySpans(turns, anchor, now, activeNow)
      : rollingSpans(turns, length);
  const spanAt = (ms: number) => spans.find((span) => span.start <= ms && ms < span.end);

  const readings = [...readingsIn]
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id))
    .map((entry) => {
      const at = Date.parse(entry.observedAt);
      const span = spanAt(at);
      const used = span ? sum(span.turns, at) : { usd: 0, tokens: 0 };
      const value = measure(unit, used);
      // used / (observed %) is the limit this reading implies; undefined at 0 on either side.
      const implied = value > 0 && entry.observedPct > 0 ? value / (entry.observedPct / 100) : null;
      return { entry, used, value, implied };
    });

  const planLimit = limit.unit === "estimated" ? null : limit.value;
  const implied = readings.flatMap((r) => (r.implied === null ? [] : [r.implied]));
  // Readings win over a published limit too: agents' costs need not match what the provider bills,
  // and the readings measure the limit in the same units we count (spec §5.3).
  const calibrated = median(implied);
  const limitValue = calibrated ?? planLimit;
  const limitSource: LimitSource =
    calibrated !== null ? "calibrated" : planLimit !== null ? "plan" : "unknown";
  const limitUsd = unit === "tokens" ? null : limitValue;
  const limitTokens = unit === "tokens" ? limitValue : null;

  const figure = (span: Span): QuotaWindow => {
    const used = sum(span.turns);
    const value = measure(unit, used);
    return {
      startsAt: iso(span.start),
      endsAt: iso(span.end),
      usedUsd: used.usd,
      usedTokens: used.tokens,
      limitUsd,
      limitTokens,
      estimatedPct: limitValue === null ? null : (value / limitValue) * 100,
      overLimitUsd: limitUsd === null ? null : Math.max(0, used.usd - limitUsd),
      limitSource,
      estimated: true,
    };
  };

  const windows = spans.filter((span) => span.start < to && span.end > from).map(figure);
  const currentSpan = spans.find((span) => span.start <= now && now < span.end);
  const current = currentSpan ? figure(currentSpan) : null;

  let projection: QuotaWindowKindReport["projection"] = null;
  if (currentSpan && limitValue !== null) {
    const value = measure(unit, sum(currentSpan.turns, now));
    const elapsed = now - currentSpan.start;
    let projectedLimitAt: string | null = null;
    if (value < limitValue && value > 0 && elapsed > 0) {
      const at = now + (limitValue - value) / (value / elapsed);
      if (at < currentSpan.end) projectedLimitAt = iso(at);
    }
    projection = { projectedLimitAt, reached: value >= limitValue, estimated: true };
  }

  const calibrationReadings: CalibrationReading[] = readings.map((reading, index) => {
    // Leave-one-out: each reading is predicted from the others, falling back to the published
    // limit, so a reading never predicts itself.
    const predictionLimit =
      median(
        readings.flatMap((other, j) =>
          j === index || other.implied === null ? [] : [other.implied],
        ),
      ) ?? planLimit;
    const predictedPct = predictionLimit === null ? null : (reading.value / predictionLimit) * 100;
    return {
      id: reading.entry.id,
      origin: reading.entry.origin,
      observedAt: reading.entry.observedAt,
      observedPct: reading.entry.observedPct,
      usedUsd: reading.used.usd,
      usedTokens: reading.used.tokens,
      predictedPct,
      deltaPct: predictedPct === null ? null : predictedPct - reading.entry.observedPct,
    };
  });
  const deltas = calibrationReadings.flatMap((r) => (r.deltaPct === null ? [] : [r.deltaPct]));

  return {
    kind,
    unit,
    limitSource,
    limitUsd,
    limitTokens,
    windows,
    current,
    resetsAt: current?.endsAt ?? null,
    projection,
    overLimitUsd: windows.reduce((total, w) => total + (w.overLimitUsd ?? 0), 0),
    calibration: {
      readings: calibrationReadings,
      meanAbsoluteDeviationPct: deltas.length
        ? deltas.reduce((total, d) => total + Math.abs(d), 0) / deltas.length
        : null,
    },
  };
}

/** Codex reports one window's reset time with a few seconds of jitter (observed: up to 3 s);
 * distinct windows reset minutes to days apart, even when they overlap (weekly). */
const PROVIDER_RESET_JITTER_MS = 5 * 60_000;

/**
 * Codex repeats its rate limits on every token count, so one burst would outweigh every other
 * reading. Keeps, per subscription, window kind and window instance, the latest reading observed
 * before the instance ends. An instance is identified by the provider's reset time; resets at most
 * `PROVIDER_RESET_JITTER_MS` apart are the same instance (Codex jitters by seconds), while
 * overlapping weekly windows reset days apart and stay separate. Output is sorted by observedAt,
 * then id.
 */
export function latestProviderReadings(
  readings: readonly ProviderQuotaReading[],
): ProviderQuotaReading[] {
  const groups = new Map<string, ProviderQuotaReading[]>();
  for (const reading of readings) {
    if (Date.parse(reading.observedAt) >= Date.parse(reading.resetsAt)) continue;
    const key = JSON.stringify([reading.subscriptionId, reading.windowKind]);
    groups.set(key, [...(groups.get(key) ?? []), reading]);
  }
  const kept: ProviderQuotaReading[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt) || a.id.localeCompare(b.id),
    );
    let instanceReset = Number.NEGATIVE_INFINITY;
    let latest: ProviderQuotaReading | undefined;
    for (const reading of sorted) {
      const reset = Date.parse(reading.resetsAt);
      if (reset - instanceReset > PROVIDER_RESET_JITTER_MS) {
        if (latest) kept.push(latest);
        instanceReset = reset;
        latest = undefined;
      }
      const at = Date.parse(reading.observedAt);
      const best = latest ? Date.parse(latest.observedAt) : Number.NEGATIVE_INFINITY;
      if (!latest || at > best || (at === best && reading.id > latest.id)) latest = reading;
    }
    if (latest) kept.push(latest);
  }
  return kept.sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.id.localeCompare(b.id),
  );
}

export function computeQuotas(input: QuotaInput): QuotaSubscriptionReport[] {
  const plans = new Map(input.plans.plans.map((plan) => [plan.id, plan]));
  const providerReadings = latestProviderReadings(input.providerReadings ?? []);
  const from = Date.parse(input.period.from);
  const to = Date.parse(input.period.to);
  const now = Date.parse(input.now);

  return input.subscriptions.flatMap((subscription) => {
    const plan = plans.get(subscription.planId);
    if (!plan) return [];
    const own = input.turns
      .filter((turn) => turn.subscriptionId === subscription.id)
      .map((turn) => ({ ...turn, ms: Date.parse(turn.ts) }))
      .sort((a, b) => a.ms - b.ms);
    const activeFrom = subscription.startedAt ? dateMs(subscription.startedAt) : null;
    const activeTo = subscription.endedAt ? dateMs(subscription.endedAt) + DAY : null;
    const activeNow =
      (activeFrom === null || now >= activeFrom) && (activeTo === null || now < activeTo);
    const firstTurn = own[0]?.ms;
    const anchor =
      activeFrom ??
      (firstTurn !== undefined
        ? dateMs(iso(firstTurn).slice(0, 10))
        : dateMs(iso(now).slice(0, 10)));

    const windows = plan.windows.map((window) => {
      // usd plans are billed on reported cost when present; estimated ones use API-equivalent cost (D3).
      const turns: Turn[] = own.map((turn) => ({
        ms: turn.ms,
        tokens: turn.tokens,
        usd:
          window.limit.unit === "usd"
            ? (turn.reportedCostUsd ?? turn.computedCostUsd ?? 0)
            : (turn.computedCostUsd ?? 0),
      }));
      const mine = (c: { subscriptionId: string; windowKind: string }) =>
        c.subscriptionId === subscription.id && c.windowKind === window.kind;
      const readings = [
        ...input.calibrations.filter(mine).map((c) => ({ ...c, origin: "manual" as const })),
        ...providerReadings.filter(mine).map(({ resetsAt: _reset, ...c }) => c),
      ];
      return kindReport(
        window.kind,
        window.limit,
        turns,
        anchor,
        activeNow,
        readings,
        from,
        to,
        now,
      );
    });

    const start = Math.max(from, activeFrom ?? from);
    const end = Math.min(to, activeTo ?? to);
    let apiEquivalentUsd = 0;
    let unpricedTurns = 0;
    for (const turn of own) {
      if (turn.ms < start || turn.ms >= end) continue;
      if (turn.computedCostUsd === null) unpricedTurns++;
      else apiEquivalentUsd += turn.computedCostUsd;
    }
    const price = plan.monthlyPriceUsd ?? null;
    const paidUsd = price === null ? null : (price * Math.max(0, end - start)) / AVERAGE_MONTH;

    return [
      {
        id: subscription.id,
        planId: plan.id,
        label: subscription.label ?? plan.label,
        provider: plan.provider,
        startedAt: subscription.startedAt ?? null,
        endedAt: subscription.endedAt ?? null,
        monthlyPriceUsd: price,
        windows,
        extractedValue: {
          apiEquivalentUsd,
          unpricedTurns,
          paidUsd,
          ratio: paidUsd ? apiEquivalentUsd / paidUsd : null,
        },
      },
    ];
  });
}
