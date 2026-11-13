// Pure Git view state: request, tokens per net line, headline totals and the tokens-per-commit
// chart (spec §7.1, Phase 4 L20). No React, no fetch.
import type { QuotasPeriod } from "../quotas/state";
import type { GitCommit, GitReport } from "./contract";

/** Only the period drives the request; other URL state never refetches. */
export function gitRequest(period: QuotasPeriod): string {
  return `/api/git?${new URLSearchParams({ from: period.from, to: period.to })}`;
}

/** tokens / (additions − deletions); null (not applicable) when the net is zero or negative. */
export function tokensPerNetLine(figures: {
  tokens: number;
  additions: number;
  deletions: number;
}): number | null {
  const net = figures.additions - figures.deletions;
  return net > 0 ? figures.tokens / net : null;
}

/** Tokens attributed to the period's commits vs orphan tokens of the period's sessions. */
export function gitTotals(report: GitReport): { attributed: number; orphan: number } {
  const sum = (items: readonly { tokens: number }[]) =>
    items.reduce((total, item) => total + item.tokens, 0);
  return { attributed: sum(report.commits), orphan: sum(report.orphanSessions) };
}

export interface TimelineRow {
  at: string;
  tokens: number;
  commit: string;
  subject: string;
}

export function timelineRows(commits: readonly GitCommit[]): TimelineRow[] {
  return commits.map((commit) => ({
    at: commit.authoredAt,
    tokens: commit.tokens,
    commit: `${commit.repo} ${commit.sha}`,
    subject: commit.subject,
  }));
}

/** Data-free Vega-Lite spec: one point per commit (time, tokens); rows go into `table`. */
export function timelineSpec(labels: {
  date: string;
  tokens: string;
  commit: string;
  subject: string;
}): Record<string, unknown> {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    mark: { type: "point", filled: true },
    encoding: {
      x: { field: "at", type: "temporal", title: labels.date },
      y: { field: "tokens", type: "quantitative", title: labels.tokens, axis: { format: "~s" } },
      tooltip: [
        { field: "commit", type: "nominal", title: labels.commit },
        { field: "subject", type: "nominal", title: labels.subject },
        { field: "at", type: "temporal", title: labels.date, format: "%c" },
        { field: "tokens", type: "quantitative", title: labels.tokens, format: "," },
      ],
    },
  };
}
