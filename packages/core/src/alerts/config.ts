import { readFileSync } from "node:fs";
import { z } from "zod";
import { WindowKindSchema } from "../schema/tables";

/**
 * Threshold alerts (spec §9, T7): the user's file is the source of truth, like the subscriptions and
 * the manual calibrations. A channel is pluggable by id, so an id nobody registered is a
 * configuration error instead of a silent no-op.
 */
export const DEFAULT_ALERT_CHANNELS = ["telegram"] as const;

export const AlertEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    subscriptionId: z.string().regex(/^[a-z0-9-]+$/),
    windowKind: WindowKindSchema,
    thresholdPct: z.number().min(1).max(100),
    channel: z.string().regex(/^[a-z0-9-]{1,32}$/),
  })
  .strict();
export type AlertEntry = z.infer<typeof AlertEntrySchema>;

export const AlertsFileSchema = z
  .object({ version: z.literal(1), alerts: z.array(AlertEntrySchema) })
  .strict()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const entry of file.alerts) {
      if (ids.has(entry.id)) ctx.addIssue({ code: "custom", message: `duplicate id ${entry.id}` });
      ids.add(entry.id);
    }
  });
export type AlertsFile = z.infer<typeof AlertsFileSchema>;

export const EMPTY_ALERTS_FILE: AlertsFile = { version: 1, alerts: [] };

export type AlertsLoad = { ok: true; file: AlertsFile } | { ok: false; error: string };

/** Parses and validates the file contents; `channels` is the registry the binary can deliver to. */
export function parseAlertsFile(
  text: string,
  channels: readonly string[] = DEFAULT_ALERT_CHANNELS,
): AlertsLoad {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid alerts config" };
  }
  const parsed = AlertsFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "invalid alerts config" };
  const registered = new Set(channels);
  if (parsed.data.alerts.some((entry) => !registered.has(entry.channel))) {
    return { ok: false, error: "invalid alerts config" };
  }
  return { ok: true, file: parsed.data };
}

/**
 * Reads the alerts file. A missing file means "no alerts configured" and is not an error; any other
 * read failure is, so a broken file is visible instead of silently disabling the alerts.
 */
export function loadAlertsFile(
  path: string,
  channels: readonly string[] = DEFAULT_ALERT_CHANNELS,
): AlertsLoad {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, file: EMPTY_ALERTS_FILE };
    return { ok: false, error: "alerts config unreadable" };
  }
  return parseAlertsFile(text, channels);
}
