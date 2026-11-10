import type { Database } from "../db/database";
import type { WindowKind } from "../schema/tables";
import { alertKey } from "./evaluate";

export interface SentAlert {
  alertId: string;
  subscriptionId: string;
  kind: WindowKind;
  windowStart: string;
  thresholdPct: number;
  sentAt: string;
}

/**
 * The keys already delivered. A row is written only after a channel accepted the message (L34), so
 * a failed send stays absent and is retried on the next pass while its instance is still active.
 */
export async function readSentAlertKeys(db: Database): Promise<Set<string>> {
  const rows = await db.all(
    "SELECT alert_id, epoch_ms(window_start) AS ms FROM alert_notifications",
  );
  return new Set(
    rows.map((row) => {
      const start = new Date(Number(row.ms)).toISOString();
      return alertKey(String(row.alert_id), start);
    }),
  );
}

export async function recordSentAlert(db: Database, sent: SentAlert): Promise<void> {
  await db.run(
    "INSERT INTO alert_notifications VALUES ($1, $2, $3, $4::TIMESTAMPTZ, $5, $6::TIMESTAMPTZ)",
    [
      sent.alertId,
      sent.subscriptionId,
      sent.kind,
      sent.windowStart,
      sent.thresholdPct,
      sent.sentAt,
    ],
  );
}
