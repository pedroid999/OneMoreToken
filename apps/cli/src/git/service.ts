import { basename } from "node:path";
import type { Database } from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SummaryPeriod } from "../summary/contract";
import { currentPricing, PRICING_CHECKPOINT_JOIN } from "../summary/service";

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
/** GET /api/git: commits authored in the period, their pull requests (aggregated over those
 * commits) and sessions with orphan turns in the period. */
export interface GitReport {
  commits: GitCommit[];
  pullRequests: GitPullRequest[];
  orphanSessions: GitOrphanSession[];
}

const number = (value: unknown, fallback: number | null = null): number | null => {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("unsafe git");
  return parsed;
};
const count = (value: unknown) => number(value, 0) ?? 0;
const iso = (value: unknown) => new Date(count(value)).toISOString();
const add = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : a + b);

/** Per-turn figures; computed cost follows the Summary's current-pricing rule. */
const TURN_FIGURES = `(u.input_tokens::DOUBLE + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens) AS tokens,
  u.reported_cost_usd AS reported, CASE WHEN c.pricing_hash = $3 THEN u.computed_cost_usd END AS computed`;

export function readGit(db: Database, period: SummaryPeriod): Promise<GitReport> {
  const { hash } = currentPricing();
  const params = [period.from, period.to, hash];
  return withDatabase(db, async () => {
    const commitRows = await db.all(
      `WITH attributed AS (
         SELECT tc.repo, tc.sha, t.session_id, ${TURN_FIGURES}
         FROM turn_commits tc JOIN turns t ON t.id = tc.turn_id
         JOIN usage u ON u.turn_id = t.id
         ${PRICING_CHECKPOINT_JOIN}
       )
       -- One row per sha: separate clones of a repository hold the same commit, which counts
       -- once (lines once, tokens of every clone's sessions summed).
       SELECT min(m.repo) AS repo, m.sha, min(m.message) AS message,
         epoch_ms(min(m.authored_at)) AS at, max(m.additions) AS additions,
         max(m.deletions) AS deletions, sum(a.tokens) AS tokens, sum(a.reported) AS reported,
         sum(a.computed) AS computed, count(DISTINCT a.session_id) AS sessions,
         min(p.pr_number) AS pr_number
       FROM commits m
       LEFT JOIN attributed a ON a.repo = m.repo AND a.sha = m.sha
       LEFT JOIN commit_pull_requests p ON p.repo = m.repo AND p.sha = m.sha
       WHERE m.authored_at >= $1::TIMESTAMPTZ AND m.authored_at < $2::TIMESTAMPTZ
       GROUP BY m.sha
       ORDER BY min(m.authored_at), min(m.repo), m.sha`,
      params,
    );
    const commits: GitCommit[] = commitRows.map((row) => ({
      repo: basename(String(row.repo)),
      sha: String(row.sha).slice(0, 7),
      subject: typeof row.message === "string" ? row.message : "",
      authoredAt: iso(row.at),
      additions: count(row.additions),
      deletions: count(row.deletions),
      tokens: count(row.tokens),
      computedCostUsd: number(row.computed),
      reportedCostUsd: number(row.reported),
      sessions: count(row.sessions),
      pullRequest: number(row.pr_number),
    }));

    const pullRequests = new Map<string, GitPullRequest>();
    for (const commit of commits) {
      if (commit.pullRequest === null) continue;
      // Clones of one repository share its PR numbers: key by display name.
      const key = JSON.stringify([commit.repo, commit.pullRequest]);
      const pr = pullRequests.get(key) ?? {
        number: commit.pullRequest,
        repo: commit.repo,
        commits: 0,
        additions: 0,
        deletions: 0,
        tokens: 0,
        computedCostUsd: null,
        reportedCostUsd: null,
      };
      pr.commits++;
      pr.additions += commit.additions;
      pr.deletions += commit.deletions;
      pr.tokens += commit.tokens;
      pr.computedCostUsd = add(pr.computedCostUsd, commit.computedCostUsd);
      pr.reportedCostUsd = add(pr.reportedCostUsd, commit.reportedCostUsd);
      pullRequests.set(key, pr);
    }

    const orphanRows = await db.all(
      `WITH orphan AS (
         SELECT t.session_id, ${TURN_FIGURES}
         FROM turns t JOIN usage u ON u.turn_id = t.id
         ${PRICING_CHECKPOINT_JOIN}
         WHERE t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ
           AND NOT EXISTS (SELECT 1 FROM turn_commits tc WHERE tc.turn_id = t.id)
       )
       SELECT s.id, s.agent, r.repo, epoch_ms(s.started_at) AS started,
         sum(o.tokens) AS tokens, sum(o.reported) AS reported, sum(o.computed) AS computed,
         EXISTS (SELECT 1 FROM turn_commits tc JOIN turns t ON t.id = tc.turn_id
                 WHERE t.session_id = s.id) AS had_commit
       FROM orphan o JOIN sessions s ON s.id = o.session_id
       LEFT JOIN session_repos r ON r.session_id = s.id
       GROUP BY s.id, s.agent, r.repo, s.started_at
       ORDER BY s.started_at, s.id`,
      params,
    );
    const orphanSessions: GitOrphanSession[] = orphanRows.map((row) => ({
      sessionId: String(row.id),
      agent: String(row.agent),
      repo: typeof row.repo === "string" ? basename(row.repo) : null,
      startedAt: iso(row.started),
      tokens: count(row.tokens),
      computedCostUsd: number(row.computed),
      reportedCostUsd: number(row.reported),
      hadCommit: row.had_commit === true,
    }));

    const repoOrder = (a: GitPullRequest, b: GitPullRequest) =>
      a.repo.localeCompare(b.repo) || a.number - b.number;
    return { commits, pullRequests: [...pullRequests.values()].sort(repoOrder), orphanSessions };
  });
}
