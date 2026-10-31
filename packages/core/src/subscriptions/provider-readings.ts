import type { Database } from "../db/database";
import type { ProviderQuotaReading } from "../quota/engine";

/** Which provider and agent each reading origin stands for in the subscription rules (L8). */
const ORIGINS = { codex: { provider: "openai", agent: "codex" } } as const;

/**
 * Provider readings attributed to the user's subscriptions with the same rule semantics as
 * `turn_subscriptions` (migration 005): the first rule, in config order, whose provider and
 * optional agent match, with the subscription active on the reading's local calendar date.
 * Readings that match no subscription are left out. Needs `syncUserSubscriptions` first.
 */
export async function readProviderQuotaReadings(db: Database): Promise<ProviderQuotaReading[]> {
  const readings: ProviderQuotaReading[] = [];
  for (const [origin, rule] of Object.entries(ORIGINS) as [
    keyof typeof ORIGINS,
    (typeof ORIGINS)[keyof typeof ORIGINS],
  ][]) {
    const rows = await db.all(
      `SELECT * FROM (
        SELECT q.id, q.window_kind, epoch_ms(q.observed_at) AS observed_ms, q.observed_pct,
          epoch_ms(q.resets_at) AS resets_ms,
          (
            SELECT r.subscription_id
            FROM subscription_rules r
            JOIN subscriptions s ON s.id = r.subscription_id
            WHERE r.provider = $2
              AND (r.agent IS NULL OR r.agent = $3)
              AND (s.started_at IS NULL OR CAST(q.observed_at AS DATE) >= s.started_at)
              AND (s.ended_at IS NULL OR CAST(q.observed_at AS DATE) <= s.ended_at)
            ORDER BY r.position
            LIMIT 1
          ) AS subscription_id
        FROM provider_quota_readings q
        WHERE q.origin = $1
      ) WHERE subscription_id IS NOT NULL
      ORDER BY observed_ms, id`,
      [origin, rule.provider, rule.agent],
    );
    for (const row of rows) {
      const observedPct = Number(row.observed_pct);
      const observedMs = Number(row.observed_ms);
      const resetsMs = Number(row.resets_ms);
      if (![observedPct, observedMs, resetsMs].every(Number.isFinite)) continue;
      readings.push({
        id: String(row.id),
        subscriptionId: String(row.subscription_id),
        windowKind: row.window_kind === "weekly" ? "weekly" : "five_hours",
        observedAt: new Date(observedMs).toISOString(),
        observedPct,
        resetsAt: new Date(resetsMs).toISOString(),
        origin,
      });
    }
  }
  return readings;
}
