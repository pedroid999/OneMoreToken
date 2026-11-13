// GET /api/git response shape (Phase 4 L14, L20). Mirrors apps/cli/src/git/service.ts: the web app
// cannot import it because the server side pulls in DuckDB through @omt/core.

/** Sums of known costs only; null when none are known. */
interface Costs {
  computedCostUsd: number | null;
  reportedCostUsd: number | null;
}
export interface GitCommit extends Costs {
  /** Display name: the basename of the repository toplevel. */
  repo: string;
  /** Short sha (7 characters). */
  sha: string;
  subject: string;
  authoredAt: string;
  additions: number;
  deletions: number;
  /** input + output + cache read + cache write of the turns attributed to this commit. */
  tokens: number;
  sessions: number;
  pullRequest: number | null;
}
export interface GitPullRequest extends Costs {
  number: number;
  repo: string;
  commits: number;
  additions: number;
  deletions: number;
  tokens: number;
}
export interface GitOrphanSession extends Costs {
  sessionId: string;
  agent: string;
  repo: string | null;
  startedAt: string;
  /** Tokens of the session's turns in the period attributed to no commit. */
  tokens: number;
  /** Whether any turn of the session was attributed to a commit. */
  hadCommit: boolean;
}
export interface GitReport {
  commits: GitCommit[];
  pullRequests: GitPullRequest[];
  orphanSessions: GitOrphanSession[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const lines = (value: Record<string, unknown>) =>
  typeof value.additions === "number" &&
  typeof value.deletions === "number" &&
  typeof value.tokens === "number";

export const isGitReport = (value: unknown): value is GitReport =>
  record(value) &&
  Array.isArray(value.commits) &&
  Array.isArray(value.pullRequests) &&
  Array.isArray(value.orphanSessions) &&
  value.commits.every(
    (commit) =>
      record(commit) &&
      typeof commit.sha === "string" &&
      typeof commit.authoredAt === "string" &&
      lines(commit),
  ) &&
  value.pullRequests.every((pr) => record(pr) && typeof pr.number === "number" && lines(pr)) &&
  value.orphanSessions.every(
    (session) =>
      record(session) &&
      typeof session.sessionId === "string" &&
      typeof session.tokens === "number",
  );
