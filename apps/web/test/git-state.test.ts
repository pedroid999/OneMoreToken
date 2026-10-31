import { describe, expect, it } from "vitest";
import type { GitCommit, GitReport } from "../src/git/contract";
import { isGitReport } from "../src/git/contract";
import {
  gitRequest,
  gitTotals,
  timelineRows,
  timelineSpec,
  tokensPerNetLine,
} from "../src/git/state";

const commit = (patch: Partial<GitCommit> = {}): GitCommit => ({
  repo: "repo-a",
  sha: "abc1234",
  subject: "feat: one",
  authoredAt: "2026-01-02T10:05:00.000Z",
  additions: 30,
  deletions: 10,
  tokens: 2_000,
  computedCostUsd: 1,
  reportedCostUsd: null,
  sessions: 1,
  pullRequest: null,
  ...patch,
});

const report = (patch: Partial<GitReport> = {}): GitReport => ({
  commits: [commit(), commit({ sha: "def5678", tokens: 500 })],
  pullRequests: [],
  orphanSessions: [
    {
      sessionId: "s-1",
      agent: "pi",
      repo: null,
      startedAt: "2026-01-02T09:00:00.000Z",
      tokens: 300,
      computedCostUsd: null,
      reportedCostUsd: null,
      hadCommit: false,
    },
  ],
  ...patch,
});

describe("git state (T3, L20)", () => {
  it("requests the period only", () => {
    expect(gitRequest({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" })).toBe(
      "/api/git?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-08T00%3A00%3A00.000Z",
    );
  });

  it("divides tokens by the net lines, not applicable when the net is zero or negative", () => {
    expect(tokensPerNetLine({ tokens: 2_000, additions: 30, deletions: 10 })).toBe(100);
    expect(tokensPerNetLine({ tokens: 0, additions: 3, deletions: 1 })).toBe(0);
    expect(tokensPerNetLine({ tokens: 2_000, additions: 5, deletions: 5 })).toBeNull();
    expect(tokensPerNetLine({ tokens: 2_000, additions: 1, deletions: 5 })).toBeNull();
  });

  it("totals attributed tokens over the commits and orphan tokens over the sessions", () => {
    expect(gitTotals(report())).toEqual({ attributed: 2_500, orphan: 300 });
    expect(gitTotals(report({ commits: [], orphanSessions: [] }))).toEqual({
      attributed: 0,
      orphan: 0,
    });
  });

  it("charts one point per commit with its time, tokens and label", () => {
    expect(timelineRows([commit()])).toEqual([
      {
        at: "2026-01-02T10:05:00.000Z",
        tokens: 2_000,
        commit: "repo-a abc1234",
        subject: "feat: one",
      },
    ]);
    const spec = timelineSpec({ date: "Date", tokens: "Tokens", commit: "Commit", subject: "S" });
    expect(spec.data).toEqual({ name: "table" });
    expect(JSON.stringify(spec)).toContain('"type":"temporal"');
    expect(JSON.stringify(spec)).not.toContain("values");
  });

  it("accepts the /api/git shape and rejects anything else", () => {
    expect(isGitReport(report())).toBe(true);
    expect(isGitReport({ commits: [] })).toBe(false);
    expect(isGitReport({ commits: [{}], pullRequests: [], orphanSessions: [] })).toBe(false);
    expect(isGitReport(null)).toBe(false);
  });
});
