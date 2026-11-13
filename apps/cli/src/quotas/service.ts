import { statSync } from "node:fs";
import {
  type CalibrationEntry,
  computeQuotas,
  type Database,
  loadSubscriptions,
  loadUserSubscriptions,
  type QuotaSubscriptionReport,
  type QuotaTurn,
  readProviderQuotaReadings,
  type SubscriptionsFile,
  syncCalibrations,
  syncUserSubscriptions,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN } from "../summary/service";

export interface Quotas {
  config: { status: "ok" | "invalid" | "missing" };
  calibrations: { status: "ok" | "invalid" };
  subscriptions: QuotaSubscriptionReport[];
}

export interface QuotasRequest {
  period: SummaryPeriod;
  configPath: string;
  /** null when the calibrations file is corrupt or unsafe: quotas are computed without readings. */
  calibrations: readonly CalibrationEntry[] | null;
  now: number;
  plans?: SubscriptionsFile;
}

function configExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

const finite = (value: unknown, fallback: number | null = null): number | null => {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("unsafe quotas");
  return number;
};

/**
 * Syncs the subscriptions config and the calibrations mirror (D1, D2), computes quotas from the
 * attributed turns and rewrites `quota_windows`, a derived cache of the returned windows. One queue
 * operation, so it never interleaves with an ingestion transaction.
 */
export async function readQuotas(db: Database, request: QuotasRequest): Promise<Quotas> {
  const plans = request.plans ?? loadSubscriptions();
  const exists = configExists(request.configPath);
  const loaded = loadUserSubscriptions(request.configPath, plans);
  const calibrations = { status: request.calibrations ? "ok" : "invalid" } as const;
  const readings = request.calibrations ?? [];
  return withDatabase(db, async () => {
    // The mirror is only rewritten from a file that reads back valid (D2).
    if (request.calibrations) await syncCalibrations(db, request.calibrations);
    if (!loaded.ok) return { config: { status: "invalid" }, calibrations, subscriptions: [] };
    await syncUserSubscriptions(db, loaded.file, plans);

    // Window history starts before the period, so every attributed turn up to the later of `to`
    // and `now` feeds the engine; it filters the windows it returns.
    const until = new Date(Math.max(Date.parse(request.period.to), request.now)).toISOString();
    // Same stale-pricing rule as the summary: computed cost from another catalog counts as unpriced.
    const { hash } = currentPricing();
    const rows = await db.all(
      `SELECT a.subscription_id, epoch_ms(t.ts) AS ms, u.reported_cost_usd,
        CASE WHEN c.pricing_hash = $2 THEN u.computed_cost_usd END AS computed_cost_usd,
        (u.input_tokens::DOUBLE + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) AS tokens
      FROM turns t JOIN usage u ON u.turn_id = t.id
      JOIN turn_subscriptions a ON a.turn_id = t.id
      ${PRICING_CHECKPOINT_JOIN}
      WHERE a.subscription_id IS NOT NULL AND t.ts < $1::TIMESTAMPTZ
      ORDER BY t.ts, t.id`,
      [until, hash],
    );
    const turns: QuotaTurn[] = rows.map((row) => ({
      subscriptionId: String(row.subscription_id),
      ts: new Date(finite(row.ms) ?? 0).toISOString(),
      reportedCostUsd: finite(row.reported_cost_usd),
      computedCostUsd: finite(row.computed_cost_usd),
      tokens: finite(row.tokens, 0) ?? 0,
    }));
    const subscriptions = computeQuotas({
      plans,
      subscriptions: loaded.file.subscriptions,
      turns,
      calibrations: readings,
      // Codex rate limits, derived at ingest (D2): attributed by the rules synced above.
      providerReadings: await readProviderQuotaReadings(db),
      period: request.period,
      now: new Date(request.now).toISOString(),
    });

    await db.run("BEGIN TRANSACTION");
    try {
      await db.run("DELETE FROM quota_windows");
      for (const subscription of subscriptions) {
        for (const kind of subscription.windows) {
          for (const window of kind.windows) {
            await db.run(
              "INSERT INTO quota_windows VALUES ($1, $2, $3, $4::TIMESTAMPTZ, $5::TIMESTAMPTZ, $6, $7, $8, $9)",
              [
                `${subscription.id}:${kind.kind}:${window.startsAt}`,
                subscription.id,
                kind.kind,
                window.startsAt,
                window.endsAt,
                Math.round(window.usedTokens),
                window.usedUsd,
                window.limitUsd,
                window.estimatedPct,
              ],
            );
          }
        }
      }
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK");
      throw error;
    }
    return { config: { status: exists ? "ok" : "missing" }, calibrations, subscriptions };
  });
}
