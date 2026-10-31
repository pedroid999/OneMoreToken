// Pure Profiles state: request, per-session figures, attribution, role categories, effort groups
// and the comparison chart (spec §6.1, §6.2; feature doc L10). No React, no fetch.
import type { QuotasPeriod } from "../quotas/state";
import type { ProfileEffort, ProfileFigures, ProfileReport, ProfileRole } from "./contract";

/** Only the period drives the request; other URL state never refetches. */
export function profilesRequest(period: QuotasPeriod): string {
  return `/api/profiles?${new URLSearchParams({ from: period.from, to: period.to })}`;
}

/** Computed cost and total tokens per root session; null when unknown. */
export function perSession(figures: ProfileFigures): {
  cost: number | null;
  tokens: number | null;
} {
  if (figures.sessions === 0) return { cost: null, tokens: null };
  return {
    cost: figures.computedCost === null ? null : figures.computedCost / figures.sessions,
    tokens: figures.total / figures.sessions,
  };
}

export type Attribution = "none" | "exact" | "estimated" | "mixed";

/** Whether the turns were attributed exactly, by estimation (spec §6.2), or both. */
export function attributionOf(figures: ProfileFigures): Attribution {
  if (figures.exactTurns === 0 && figures.estimatedTurns === 0) return "none";
  if (figures.estimatedTurns === 0) return "exact";
  return figures.exactTurns === 0 ? "estimated" : "mixed";
}

/** Token shares, or turn shares when the turns carry no tokens. */
export function attributionShares(figures: ProfileFigures): { exact: number; estimated: number } {
  if (figures.exactShare !== null && figures.estimatedShare !== null) {
    return { exact: figures.exactShare, estimated: figures.estimatedShare };
  }
  const turns = figures.exactTurns + figures.estimatedTurns;
  return turns === 0
    ? { exact: 0, estimated: 0 }
    : { exact: figures.exactTurns / turns, estimated: figures.estimatedTurns / turns };
}

/** Spec §6.1 role categories, in display order; `outside` = turns outside gentle-shell. */
export const ROLE_CATEGORIES = [
  "orchestrator",
  "explorer",
  "writer",
  "verifier",
  "reviewer",
  "other",
  "unknown",
  "outside",
] as const;
export type RoleCategory = (typeof ROLE_CATEGORIES)[number];

/**
 * Category of a stored role. Subagent roles are gentle-shell agent names (`gentle-ai-explore`,
 * `gentle-ai-worker`, `gentle-ai-verify`, `review-*`, `jd-*`), kept as stored by the server.
 */
export function roleCategory(role: string | null): RoleCategory {
  if (role === null) return "outside";
  if (role === "orchestrator" || role === "unknown") return role;
  if (/explore/.test(role)) return "explorer";
  if (/worker|writer/.test(role)) return "writer";
  if (/verif/.test(role)) return "verifier";
  if (/^(review|jd-)|judge/.test(role)) return "reviewer";
  return "other";
}

export function sortedRoles(roles: readonly ProfileRole[]): ProfileRole[] {
  const rank = (role: string | null) => ROLE_CATEGORIES.indexOf(roleCategory(role));
  return [...roles].sort(
    (a, b) => rank(a.role) - rank(b.role) || (a.role ?? "").localeCompare(b.role ?? ""),
  );
}

export interface EffortGroup {
  provider: string | null;
  model: string | null;
  /** Same model used with more than one effort in the profile. */
  compared: boolean;
  rows: ProfileEffort[];
}

/** Efforts grouped by provider and model, keeping the server order. */
export function effortGroups(efforts: readonly ProfileEffort[]): EffortGroup[] {
  const groups: EffortGroup[] = [];
  for (const row of efforts) {
    const last = groups.at(-1);
    if (last && last.provider === row.provider && last.model === row.model) last.rows.push(row);
    else groups.push({ provider: row.provider, model: row.model, compared: false, rows: [row] });
  }
  for (const group of groups) group.compared = group.rows.length > 1;
  return groups;
}

/** Snapshot hashes are sha256 hex; 12 characters tell versions apart on screen. */
export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Stable colour of a profile (spec §8.2): the same name always gets the same palette entry. */
export function profileColor(name: string, palette: readonly string[]): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return palette[hash % palette.length] ?? "";
}

export interface ComparisonRow {
  profile: string;
  color: string;
  cost: number | null;
  tokens: number;
  costPerSession: number | null;
  tokensPerSession: number | null;
}

export function comparisonRows(
  profiles: readonly ProfileReport[],
  palette: readonly string[],
): ComparisonRow[] {
  return profiles.map((profile) => {
    const each = perSession(profile.totals);
    return {
      profile: profile.name,
      color: profileColor(profile.name, palette),
      cost: profile.totals.computedCost,
      tokens: profile.totals.total,
      costPerSession: each.cost,
      tokensPerSession: each.tokens,
    };
  });
}

/** Data-free Vega-Lite spec: cost and tokens per profile side by side; rows go into `table`. */
export function comparisonSpec(labels: {
  profile: string;
  cost: string;
  tokens: string;
  domain: readonly string[];
  colors: readonly string[];
}): Record<string, unknown> {
  const bar = (field: string, title: string, format: string) => ({
    height: { step: 24 },
    mark: { type: "bar", cornerRadiusEnd: 2 },
    encoding: {
      y: { field: "profile", type: "nominal", title: labels.profile, sort: null },
      x: { field, type: "quantitative", title, axis: { format } },
      color: {
        field: "profile",
        type: "nominal",
        legend: null,
        scale: { domain: [...labels.domain], range: [...labels.colors] },
      },
      tooltip: [
        { field: "profile", type: "nominal", title: labels.profile },
        { field, type: "quantitative", title, format },
      ],
    },
  });
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    hconcat: [bar("cost", labels.cost, "$,.2f"), bar("tokens", labels.tokens, "~s")],
  };
}
