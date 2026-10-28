/** Aggregate-only GET /api/profiles contract (spec §6.1, §6.2, L10). */
import type { SummaryPeriod } from "../summary/contract";

/** Turns of the period that carry the figure; costs are null when none is known. */
export interface ProfileFigures {
  turns: number;
  /** Distinct root sessions: a child session counts as its parent's. */
  sessions: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** Computed cost priced with the current catalog only, as in the Summary. */
  computedCost: number | null;
  reportedCost: number | null;
  exactTurns: number;
  estimatedTurns: number;
  /** Share of total tokens attributed exactly / by estimation; null without tokens. */
  exactShare: number | null;
  estimatedShare: number | null;
}

export interface ProfileReport {
  name: string;
  /** Snapshots of this name used in the period, oldest first (spec §6.2). */
  versions: { hash: string; firstSeenAt: string }[];
  totals: ProfileFigures;
  /** Per root session, child sessions included, ordered by start. */
  sessions: ({
    sessionId: string;
    agent: string | null;
    startedAt: string | null;
  } & ProfileFigures)[];
  /** `orchestrator`, the subagent role, `unknown`; null outside gentle-shell. */
  roles: ({ role: string | null } & ProfileFigures)[];
  /** Effort as an independent dimension: same model, different effort. */
  efforts: ({
    provider: string | null;
    model: string | null;
    effort: string | null;
  } & ProfileFigures)[];
  /** Subscriptions drained; null id = pay-as-you-go API. */
  subscriptions: ({ subscriptionId: string | null; label: string | null } & ProfileFigures)[];
}

export interface ProfilesResponse {
  period: SummaryPeriod;
  profiles: ProfileReport[];
  /** gentle-shell turns of the period without a profile (ambiguous or no match). */
  unattributed: ProfileFigures;
}
