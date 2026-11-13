import {
  type AlertChannelRegistry,
  type Database,
  evaluateAlerts,
  loadAlertsFile,
  type ReportLanguage,
  readSentAlertKeys,
  recordSentAlert,
  renderAlert,
} from "@omt/core";
import { allowedWindowsFor } from "../calibrations/allowed";
import { createCalibrationStore } from "../calibrations/store";
import { readQuotas } from "../quotas/service";

const DAY = 86_400_000;
/** Every window kind is at most a month long, so this lookback always holds the active instances. */
const LOOKBACK_DAYS = 31;

export interface AlertsOptions {
  /** The user's subscriptions file: quotas and calibration readings. */
  configPath: string;
  /** Manual quota readings; a corrupt file degrades to quotas without readings. */
  calibrationsPath: string;
  /** The threshold alerts file (T7). */
  alertsPath: string;
  language: ReportLanguage;
  now: () => number;
  /** The channels this process can deliver to; an alert naming another one is a config error. */
  channels: AlertChannelRegistry;
  /** English diagnostics (spec §8.5); it never receives a credential. */
  onDiagnostic?: (message: string) => void;
}

export interface AlertPassResult {
  /** Alerts in the user's file. */
  configured: number;
  /** Instances that crossed their threshold and were not delivered yet. */
  due: number;
  sent: number;
  failed: number;
}

/**
 * One alert pass (T7): read the user's alerts, compute the current quota windows and deliver the
 * instances that crossed their threshold exactly once. A failed delivery is not recorded, so the
 * next pass retries it while the instance is still active (L34).
 */
export async function runAlertPass(db: Database, options: AlertsOptions): Promise<AlertPassResult> {
  const now = options.now();
  const empty: AlertPassResult = { configured: 0, due: 0, sent: 0, failed: 0 };
  const loaded = loadAlertsFile(options.alertsPath, [...options.channels.keys()]);
  if (!loaded.ok) {
    options.onDiagnostic?.(`alerts: ${loaded.error}`);
    return empty;
  }
  if (loaded.file.alerts.length === 0) return empty;

  const to = new Date(now).toISOString();
  const calibrations = await createCalibrationStore(
    options.calibrationsPath,
    allowedWindowsFor(options.configPath),
  )
    .list()
    .catch(() => null);
  const quotas = await readQuotas(db, {
    period: { from: new Date(now - LOOKBACK_DAYS * DAY).toISOString(), to },
    configPath: options.configPath,
    calibrations,
    now,
  });
  const events = evaluateAlerts({
    alerts: loaded.file.alerts,
    subscriptions: quotas.subscriptions,
    sent: await readSentAlertKeys(db),
    now: to,
  });

  let sent = 0;
  let failed = 0;
  for (const event of events) {
    const channel = options.channels.get(event.channel);
    if (!channel) {
      options.onDiagnostic?.(`alerts: no channel "${event.channel}" for alert "${event.alertId}"`);
      failed += 1;
      continue;
    }
    try {
      await channel.send(renderAlert(event, options.language));
    } catch (error) {
      options.onDiagnostic?.(
        `alerts: delivery failed for alert "${event.alertId}": ${(error as Error).message}`,
      );
      failed += 1;
      continue;
    }
    await recordSentAlert(db, {
      alertId: event.alertId,
      subscriptionId: event.subscriptionId,
      kind: event.windowKind,
      windowStart: event.windowStart,
      thresholdPct: event.thresholdPct,
      sentAt: to,
    });
    sent += 1;
  }
  return { configured: loaded.file.alerts.length, due: events.length, sent, failed };
}
