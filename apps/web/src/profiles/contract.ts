// GET /api/profiles response shape (feature doc L10, L14). Mirrors apps/cli/src/profiles/contract.ts:
// the web app cannot import it because the server side pulls in DuckDB through @omt/core.

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

export type ProfileSession = {
  sessionId: string;
  agent: string | null;
  startedAt: string | null;
} & ProfileFigures;

export type ProfileRole = { role: string | null } & ProfileFigures;

export type ProfileEffort = {
  provider: string | null;
  model: string | null;
  effort: string | null;
} & ProfileFigures;

export type ProfileSubscription = {
  /** null = pay-as-you-go API. */
  subscriptionId: string | null;
  label: string | null;
} & ProfileFigures;

export interface ProfileReport {
  name: string;
  /** Snapshots of this name used in the period, oldest first (spec §6.2). */
  versions: { hash: string; firstSeenAt: string }[];
  totals: ProfileFigures;
  sessions: ProfileSession[];
  roles: ProfileRole[];
  efforts: ProfileEffort[];
  subscriptions: ProfileSubscription[];
}

export interface Profiles {
  period: { from: string; to: string };
  profiles: ProfileReport[];
  /** gentle-shell turns of the period without a profile (ambiguous or no match). */
  unattributed: ProfileFigures;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const figures = (value: unknown): value is ProfileFigures =>
  record(value) && typeof value.turns === "number" && typeof value.total === "number";

export const isProfiles = (value: unknown): value is Profiles =>
  record(value) &&
  Array.isArray(value.profiles) &&
  figures(value.unattributed) &&
  value.profiles.every(
    (profile) =>
      record(profile) &&
      typeof profile.name === "string" &&
      figures(profile.totals) &&
      Array.isArray(profile.versions) &&
      Array.isArray(profile.sessions) &&
      Array.isArray(profile.roles) &&
      Array.isArray(profile.efforts) &&
      Array.isArray(profile.subscriptions),
  );
