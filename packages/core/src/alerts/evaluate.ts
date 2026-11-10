import type {
  LimitSource,
  QuotaSubscriptionReport,
  QuotaWindow,
  QuotaWindowKindReport,
} from "../quota/engine";
import type { WindowKind } from "../schema/tables";
import type { AlertEntry } from "./config";

/** One window instance that crossed its threshold and still has to be delivered (L34). */
export interface AlertEvent {
  alertId: string;
  channel: string;
  subscriptionId: string;
  subscriptionLabel: string;
  windowKind: WindowKind;
  windowStart: string;
  windowEnd: string;
  thresholdPct: number;
  estimatedPct: number;
  usedUsd: number;
  limitUsd: number | null;
  limitSource: LimitSource;
}

/** A delivered alert is identified by its alert and the instance it measured, never by the pass. */
export function alertKey(alertId: string, windowStart: string): string {
  return `${alertId}:${windowStart}`;
}

function isActive(window: QuotaWindow, now: number): boolean {
  return Date.parse(window.startsAt) <= now && now < Date.parse(window.endsAt);
}

function kindOf(
  subscription: QuotaSubscriptionReport,
  kind: WindowKind,
): QuotaWindowKindReport | undefined {
  return subscription.windows.find((report) => report.kind === kind);
}

/**
 * Selects the messages to send now: active instances only (a first run never replays the past), at
 * or above the configured threshold, with a known limit, and not delivered yet. Iterates in file
 * order so two passes over the same state always produce the same list.
 */
export function evaluateAlerts(input: {
  alerts: readonly AlertEntry[];
  subscriptions: readonly QuotaSubscriptionReport[];
  /** `alertKey` values already delivered. */
  sent: Iterable<string>;
  now: string;
}): AlertEvent[] {
  const now = Date.parse(input.now);
  const delivered = new Set(input.sent);
  const events: AlertEvent[] = [];
  for (const alert of input.alerts) {
    const subscription = input.subscriptions.find((report) => report.id === alert.subscriptionId);
    if (!subscription) continue;
    const kind = kindOf(subscription, alert.windowKind);
    if (!kind) continue;
    for (const window of kind.windows) {
      if (!isActive(window, now)) continue;
      if (window.estimatedPct === null) continue;
      if (window.estimatedPct < alert.thresholdPct) continue;
      if (delivered.has(alertKey(alert.id, window.startsAt))) continue;
      events.push({
        alertId: alert.id,
        channel: alert.channel,
        subscriptionId: subscription.id,
        subscriptionLabel: subscription.label,
        windowKind: kind.kind,
        windowStart: window.startsAt,
        windowEnd: window.endsAt,
        thresholdPct: alert.thresholdPct,
        estimatedPct: window.estimatedPct,
        usedUsd: window.usedUsd,
        limitUsd: window.limitUsd,
        limitSource: window.limitSource,
      });
    }
  }
  return events;
}
