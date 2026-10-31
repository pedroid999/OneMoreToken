import {
  type Database,
  loadSubscriptions,
  loadUserSubscriptions,
  type SubscriptionsFile,
  syncUserSubscriptions,
  TURN_ROLE_SQL,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN } from "../summary/service";
import type { ProfileFigures, ProfileReport, ProfilesResponse } from "./contract";

export interface ProfilesRequest {
  period: SummaryPeriod;
  configPath: string;
  plans?: SubscriptionsFile;
}

function numeric(value: unknown, integer = true): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe profiles");
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error("unsafe profiles");
  }
  return number;
}
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** One aggregated group of turns; every breakdown is a sum of groups. */
interface Group {
  root: string;
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  computed: number;
  computedKnown: number;
  reported: number;
  reportedKnown: number;
  exact: boolean;
}

class Accumulator {
  private roots = new Set<string>();
  private sums = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    computed: 0,
    computedKnown: 0,
    reported: 0,
    reportedKnown: 0,
    exactTurns: 0,
    estimatedTurns: 0,
    exactTokens: 0,
    estimatedTokens: 0,
  };
  add(group: Group, attributed: boolean): this {
    const s = this.sums;
    this.roots.add(group.root);
    s.turns += group.turns;
    s.input += group.input;
    s.output += group.output;
    s.cacheRead += group.cacheRead;
    s.cacheWrite += group.cacheWrite;
    s.computed += group.computed;
    s.computedKnown += group.computedKnown;
    s.reported += group.reported;
    s.reportedKnown += group.reportedKnown;
    if (attributed) {
      const tokens = group.input + group.output + group.cacheRead + group.cacheWrite;
      if (group.exact) {
        s.exactTurns += group.turns;
        s.exactTokens += tokens;
      } else {
        s.estimatedTurns += group.turns;
        s.estimatedTokens += tokens;
      }
    }
    return this;
  }
  figures(): ProfileFigures {
    const s = this.sums;
    const total = numeric(s.input + s.output + s.cacheRead + s.cacheWrite);
    return {
      turns: s.turns,
      sessions: this.roots.size,
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
      total,
      computedCost: s.computedKnown ? numeric(s.computed, false) : null,
      reportedCost: s.reportedKnown ? numeric(s.reported, false) : null,
      exactTurns: s.exactTurns,
      estimatedTurns: s.estimatedTurns,
      exactShare: total ? s.exactTokens / total : null,
      estimatedShare: total ? s.estimatedTokens / total : null,
    };
  }
}

/** Groups keyed by a JSON tuple, sorted by that tuple with nulls last. */
class Breakdown<K extends (string | null)[]> {
  private groups = new Map<string, { key: K; sum: Accumulator }>();
  add(key: K, group: Group, attributed = true) {
    const id = JSON.stringify(key);
    let entry = this.groups.get(id);
    if (!entry) {
      entry = { key, sum: new Accumulator() };
      this.groups.set(id, entry);
    }
    entry.sum.add(group, attributed);
  }
  sorted() {
    const compare = (a: K, b: K) => {
      for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? null;
        const y = b[i] ?? null;
        if (x === y) continue;
        if (x === null) return 1;
        if (y === null) return -1;
        return x < y ? -1 : 1;
      }
      return 0;
    };
    return [...this.groups.values()]
      .sort((a, b) => compare(a.key, b.key))
      .map(({ key, sum }) => ({ key, figures: sum.figures() }));
  }
}

/**
 * Per-profile cost and tokens (spec §6.1): totals, per root session (children included), per role,
 * per effort and per subscription drained, with exact vs estimated shares (spec §6.2). Syncs a valid
 * subscriptions config first, like the quotas; an invalid one keeps the last synced subscriptions.
 * One queue operation; computed cost follows the summary's stale-pricing rule.
 */
export async function readProfiles(
  db: Database,
  request: ProfilesRequest,
): Promise<ProfilesResponse> {
  const plans = request.plans ?? loadSubscriptions();
  const loaded = loadUserSubscriptions(request.configPath, plans);
  return withDatabase(db, async () => {
    if (loaded.ok) await syncUserSubscriptions(db, loaded.file, plans);
    const { hash } = currentPricing();
    const rows = await db.all(
      `SELECT pp.name AS profile, tp.profile_hash, tp.attribution,
        coalesce(s.parent_session_id, s.id) AS root, rs.agent AS root_agent,
        strftime(rs.started_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS root_started,
        ${TURN_ROLE_SQL} AS role, t.provider, t.model, t.effort,
        a.subscription_id, sub.label AS subscription_label,
        count(*) AS turns,
        coalesce(sum(u.input_tokens), 0) AS input,
        coalesce(sum(u.output_tokens), 0) AS output,
        coalesce(sum(u.cache_read_tokens), 0) AS cache_read,
        coalesce(sum(u.cache_write_tokens), 0) AS cache_write,
        coalesce(sum(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END), 0) AS computed,
        count(CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END) AS computed_known,
        coalesce(sum(u.reported_cost_usd), 0) AS reported,
        count(u.reported_cost_usd) AS reported_known
      FROM turns t
      LEFT JOIN usage u ON u.turn_id = t.id
      ${PRICING_CHECKPOINT_JOIN}
      LEFT JOIN subagent_runs r ON r.id = s.id
      LEFT JOIN sessions rs ON rs.id = coalesce(s.parent_session_id, s.id)
      LEFT JOIN turn_profile tp ON tp.turn_id = t.id
      LEFT JOIN profiles pp ON pp.hash = tp.profile_hash
      LEFT JOIN turn_subscriptions a ON a.turn_id = t.id
      LEFT JOIN subscriptions sub ON sub.id = a.subscription_id
      WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
        AND (tp.turn_id IS NOT NULL OR s.agent = 'gentle-shell')
      GROUP BY ALL`,
      [request.period.from, request.period.to, hash],
    );
    const versions = new Map(
      (
        await db.all(
          `SELECT hash, strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS seen
           FROM profiles`,
        )
      ).map((row) => [String(row.hash), String(row.seen)]),
    );

    interface Building {
      hashes: Set<string>;
      totals: Accumulator;
      sessions: Breakdown<[string | null, string]>;
      sessionInfo: Map<string, { agent: string | null; startedAt: string | null }>;
      roles: Breakdown<[string | null]>;
      efforts: Breakdown<[string | null, string | null, string | null]>;
      subscriptions: Breakdown<[string | null, string | null]>;
    }
    const profiles = new Map<string, Building>();
    const unattributed = new Accumulator();
    for (const row of rows) {
      const group: Group = {
        root: String(row.root),
        turns: numeric(row.turns),
        input: numeric(row.input),
        output: numeric(row.output),
        cacheRead: numeric(row.cache_read),
        cacheWrite: numeric(row.cache_write),
        computed: numeric(row.computed, false),
        computedKnown: numeric(row.computed_known),
        reported: numeric(row.reported, false),
        reportedKnown: numeric(row.reported_known),
        exact: row.attribution === "exact",
      };
      const name = text(row.profile);
      if (!name) {
        unattributed.add(group, false);
        continue;
      }
      let profile = profiles.get(name);
      if (!profile) {
        profile = {
          hashes: new Set(),
          totals: new Accumulator(),
          sessions: new Breakdown(),
          sessionInfo: new Map(),
          roles: new Breakdown(),
          efforts: new Breakdown(),
          subscriptions: new Breakdown(),
        };
        profiles.set(name, profile);
      }
      const startedAt = text(row.root_started);
      profile.hashes.add(String(row.profile_hash));
      profile.totals.add(group, true);
      profile.sessionInfo.set(group.root, { agent: text(row.root_agent), startedAt });
      profile.sessions.add([startedAt, group.root], group);
      profile.roles.add([text(row.role)], group);
      profile.efforts.add([text(row.provider), text(row.model), text(row.effort)], group);
      profile.subscriptions.add([text(row.subscription_id), text(row.subscription_label)], group);
    }

    const reports: ProfileReport[] = [...profiles.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, profile]) => ({
        name,
        versions: [...profile.hashes]
          .map((hash) => ({ hash, firstSeenAt: versions.get(hash) ?? "" }))
          .sort(
            (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.hash.localeCompare(b.hash),
          ),
        totals: profile.totals.figures(),
        sessions: profile.sessions.sorted().map(({ key: [, sessionId], figures }) => ({
          sessionId,
          agent: profile.sessionInfo.get(sessionId)?.agent ?? null,
          startedAt: profile.sessionInfo.get(sessionId)?.startedAt ?? null,
          ...figures,
        })),
        roles: profile.roles.sorted().map(({ key: [role], figures }) => ({ role, ...figures })),
        efforts: profile.efforts.sorted().map(({ key: [provider, model, effort], figures }) => ({
          provider,
          model,
          effort,
          ...figures,
        })),
        subscriptions: profile.subscriptions
          .sorted()
          .map(({ key: [subscriptionId, label], figures }) => ({
            subscriptionId,
            label,
            ...figures,
          })),
      }));
    return { period: request.period, profiles: reports, unattributed: unattributed.figures() };
  });
}
