import {
  type CalibrationEntry,
  type CalibrationOrigin,
  type Database,
  latestProviderReadings,
  loadSubscriptions,
  loadUserSubscriptions,
  readProviderQuotaReadings,
  type SubscriptionsFile,
  syncUserSubscriptions,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { CalibrationStore } from "./store";

/** One row of GET /api/calibrations: a manual entry or a read-only provider reading. */
export type ListedCalibration = CalibrationEntry & { origin: CalibrationOrigin };

/**
 * Manual readings from the user's file plus provider readings derived at ingest (L8). Provider
 * readings are reduced like the engine reduces them, to the latest one per window instance, and
 * only those attributed to a configured subscription are listed. A corrupt or unsafe file still
 * fails with its CalibrationError; an invalid subscriptions config only hides provider readings.
 */
export async function listCalibrations(
  db: Database,
  store: CalibrationStore,
  configPath: string,
  plans: SubscriptionsFile = loadSubscriptions(),
): Promise<ListedCalibration[]> {
  const manual = (await store.list()).map((entry) => ({ ...entry, origin: "manual" as const }));
  const loaded = loadUserSubscriptions(configPath, plans);
  if (!loaded.ok) return manual;
  const provider = await withDatabase(db, async () => {
    await syncUserSubscriptions(db, loaded.file, plans);
    return latestProviderReadings(await readProviderQuotaReadings(db));
  });
  return [...manual, ...provider.map(({ resetsAt: _reset, ...reading }) => reading)];
}
