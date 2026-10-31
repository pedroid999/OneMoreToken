import { z } from "zod";
import type { Database } from "../db/database";
import { WindowKindSchema } from "../schema/tables";

/**
 * Manual readings of the % the provider console shows (spec §5.3). They cannot be rebuilt from agent
 * data, so their source of truth is a local file; the `calibrations` table is only a mirror.
 */
export const CalibrationEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    subscriptionId: z.string().regex(/^[a-z0-9-]+$/),
    windowKind: WindowKindSchema,
    observedAt: z.iso.datetime({ offset: true }),
    observedPct: z.number().min(0).max(100),
    note: z.string().max(200).optional(),
  })
  .strict();
export type CalibrationEntry = z.infer<typeof CalibrationEntrySchema>;

export const CalibrationsFileSchema = z
  .object({ version: z.literal(1), calibrations: z.array(CalibrationEntrySchema) })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const entry of file.calibrations) {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${entry.id}` });
      ids.add(entry.id);
    }
  });
export type CalibrationsFile = z.infer<typeof CalibrationsFileSchema>;

/** Replaces the `calibrations` mirror with the given entries in one transaction. */
export async function syncCalibrations(
  db: Database,
  entries: readonly CalibrationEntry[],
): Promise<void> {
  await db.run("BEGIN TRANSACTION");
  try {
    await db.run("DELETE FROM calibrations");
    for (const entry of entries) {
      await db.run("INSERT INTO calibrations VALUES ($1, $2, $3, $4, $5, $6)", [
        entry.id,
        entry.subscriptionId,
        entry.windowKind,
        entry.observedAt,
        entry.observedPct,
        entry.note ?? null,
      ]);
    }
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}
