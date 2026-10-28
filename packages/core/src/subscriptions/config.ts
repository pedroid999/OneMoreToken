import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SubscriptionsFile } from "../data/files";
import type { Database } from "../db/database";

/**
 * The user's own subscriptions (spec §4, §5): which plan they pay for, since when, and which providers
 * (optionally narrowed to one agent) draw from it. It lives outside the repository, in
 * `${XDG_CONFIG_HOME:-~/.config}/one-more-token/subscriptions.json`; plans and limits stay in data/.
 */
const date = z.iso.date();

const UserSubscriptionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    planId: z.string().min(1),
    label: z.string().min(1).optional(),
    startedAt: date.optional(),
    endedAt: date.optional(),
    match: z
      .array(
        z.object({ provider: z.string().min(1), agent: z.string().min(1).optional() }).strict(),
      )
      .min(1),
  })
  .strict();

export const UserSubscriptionsFileSchema = z
  .object({ version: z.literal(1), subscriptions: z.array(UserSubscriptionSchema) })
  .strict();
export type UserSubscriptionsFile = z.infer<typeof UserSubscriptionsFileSchema>;

export type UserSubscriptionsResult =
  | { ok: true; file: UserSubscriptionsFile }
  | { ok: false; error: "invalid subscriptions config" };

const EMPTY: UserSubscriptionsFile = { version: 1, subscriptions: [] };

/** Validates the file against its schema and the known plans. A missing file means no subscriptions. */
export function parseUserSubscriptions(
  raw: unknown,
  plans: SubscriptionsFile,
): UserSubscriptionsResult {
  const parsed = UserSubscriptionsFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid subscriptions config" };
  const planIds = new Set(plans.plans.map((plan) => plan.id));
  const ids = new Set<string>();
  for (const subscription of parsed.data.subscriptions) {
    const { id, planId, startedAt, endedAt } = subscription;
    if (ids.has(id) || !planIds.has(planId))
      return { ok: false, error: "invalid subscriptions config" };
    if (startedAt !== undefined && endedAt !== undefined && endedAt < startedAt) {
      return { ok: false, error: "invalid subscriptions config" };
    }
    ids.add(id);
  }
  return { ok: true, file: parsed.data };
}

export function loadUserSubscriptions(
  path: string,
  plans: SubscriptionsFile,
): UserSubscriptionsResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, file: EMPTY };
    return { ok: false, error: "invalid subscriptions config" };
  }
  try {
    return parseUserSubscriptions(JSON.parse(text), plans);
  } catch {
    return { ok: false, error: "invalid subscriptions config" };
  }
}

/**
 * Replaces `subscriptions` and `subscription_rules` with the given config in one transaction. Both
 * tables are fully derived from the local file, so rewriting them loses nothing.
 */
export async function syncUserSubscriptions(
  db: Database,
  file: UserSubscriptionsFile,
  plans: SubscriptionsFile,
): Promise<void> {
  const planById = new Map(plans.plans.map((plan) => [plan.id, plan]));
  await db.run("BEGIN TRANSACTION");
  try {
    await db.run("DELETE FROM subscription_rules");
    await db.run("DELETE FROM subscriptions");
    let position = 0;
    for (const subscription of file.subscriptions) {
      const plan = planById.get(subscription.planId);
      if (!plan) throw new Error(`unknown plan ${subscription.planId}`);
      await db.run("INSERT INTO subscriptions VALUES ($1, $2, $3, $4, $5, $6)", [
        subscription.id,
        plan.id,
        plan.provider,
        subscription.label ?? plan.label,
        subscription.startedAt ?? null,
        subscription.endedAt ?? null,
      ]);
      for (const rule of subscription.match) {
        await db.run("INSERT INTO subscription_rules VALUES ($1, $2, $3, $4)", [
          position++,
          subscription.id,
          rule.provider,
          rule.agent ?? null,
        ]);
      }
    }
    await db.run("COMMIT");
  } catch (error) {
    await db.run("ROLLBACK");
    throw error;
  }
}
