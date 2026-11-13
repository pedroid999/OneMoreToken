import { listValue } from "@duckdb/node-api";
import type { Database } from "../db/database";
import { CommitPullRequestSchema, type Row, SessionRepoSchema } from "../schema/tables";

async function transaction(db: Database, work: () => Promise<void>): Promise<void> {
  await db.run("BEGIN TRANSACTION");
  try {
    await work();
    await db.run("COMMIT");
  } catch (error) {
    try {
      await db.run("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

/** Upserts session → repository links; links of sessions not given are kept (L14 (3)). */
export async function upsertSessionRepos(
  db: Database,
  rows: readonly Row<"session_repos">[],
): Promise<void> {
  if (rows.length === 0) return;
  const valid = rows.map((row) => SessionRepoSchema.parse(row));
  await transaction(db, () =>
    db.run(
      `INSERT OR REPLACE INTO session_repos (session_id, repo)
       SELECT unnest($1::VARCHAR[]), unnest($2::VARCHAR[])`,
      [listValue(valid.map((row) => row.session_id)), listValue(valid.map((row) => row.repo))],
    ),
  );
}

/** Upserts the user's commits of one repository and their pull requests; nothing is deleted, so
 * re-ingest is idempotent and commits no longer reachable are kept (L14 (2), (3)). */
export async function upsertRepoCommits(
  db: Database,
  commits: readonly Row<"commits">[],
  pullRequests: readonly Row<"commit_pull_requests">[],
): Promise<void> {
  const prs = pullRequests.map((row) => CommitPullRequestSchema.parse(row));
  await transaction(db, async () => {
    if (commits.length > 0) {
      await db.run(
        `INSERT OR REPLACE INTO commits (repo, sha, authored_at, author, message, additions, deletions)
         SELECT unnest($1::VARCHAR[]), unnest($2::VARCHAR[]), unnest($3::TIMESTAMPTZ[]), NULL,
           unnest($4::VARCHAR[]), unnest($5::INTEGER[]), unnest($6::INTEGER[])`,
        [
          listValue(commits.map((row) => row.repo)),
          listValue(commits.map((row) => row.sha)),
          listValue(commits.map((row) => row.authored_at)),
          listValue(commits.map((row) => row.message)),
          listValue(commits.map((row) => row.additions)),
          listValue(commits.map((row) => row.deletions)),
        ],
      );
    }
    if (prs.length > 0) {
      await db.run(
        `INSERT OR REPLACE INTO commit_pull_requests (repo, sha, pr_number)
         SELECT unnest($1::VARCHAR[]), unnest($2::VARCHAR[]), unnest($3::INTEGER[])`,
        [
          listValue(prs.map((row) => row.repo)),
          listValue(prs.map((row) => row.sha)),
          listValue(prs.map((row) => row.pr_number)),
        ],
      );
    }
  });
}
