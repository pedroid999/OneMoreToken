import { listValue } from "@duckdb/node-api";
import type { Database } from "../db/database";

/** A commit counts for a session's turns when it lands at most this long after the session ends. */
export const COMMIT_GRACE_MS = 30 * 60 * 1000;

const ms = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("unsafe commit attribution");
  return number;
};

/**
 * Rewrites `turn_commits` in full (L13, L14 (3)-(4)); derived data, so running it twice changes
 * nothing. Each turn of a session linked to a repository goes to the earliest stored commit of that
 * repository authored at or after the turn, when that commit lands no later than 30 minutes after
 * the session ends (its latest turn, or `ended_at` when later). Other turns are orphan (no row).
 * `commits` only holds the user's commits. The caller owns the writer queue.
 */
export async function recomputeCommitAttribution(db: Database): Promise<{ attributed: number }> {
  const commitRows = await db.all(
    `SELECT repo, sha, epoch_ms(authored_at) AS at FROM commits ORDER BY repo, authored_at, sha`,
  );
  const commits = new Map<string, { sha: string; at: number }[]>();
  for (const row of commitRows) {
    const repo = String(row.repo);
    const list = commits.get(repo) ?? [];
    list.push({ sha: String(row.sha), at: ms(row.at) });
    commits.set(repo, list);
  }
  const turns = await db.all(
    `WITH ends AS (
       SELECT s.id, greatest(coalesce(s.ended_at, s.started_at), coalesce(max(t.ts), s.started_at)) AS ended
       FROM sessions s LEFT JOIN turns t ON t.session_id = s.id GROUP BY s.id, s.ended_at, s.started_at
     )
     SELECT t.id, epoch_ms(t.ts) AS ts, r.repo, epoch_ms(e.ended) AS ended
     FROM turns t JOIN session_repos r ON r.session_id = t.session_id
     JOIN ends e ON e.id = t.session_id
     ORDER BY t.id`,
  );

  const ids: string[] = [];
  const repos: string[] = [];
  const shas: string[] = [];
  for (const turn of turns) {
    const repo = String(turn.repo);
    const list = commits.get(repo);
    if (!list) continue;
    const ts = ms(turn.ts);
    // First commit authored at or after the turn (binary search over the sorted list).
    let low = 0;
    let high = list.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((list[mid]?.at ?? Infinity) < ts) low = mid + 1;
      else high = mid;
    }
    const next = list[low];
    if (!next || next.at > ms(turn.ended) + COMMIT_GRACE_MS) continue;
    ids.push(String(turn.id));
    repos.push(repo);
    shas.push(next.sha);
  }

  await db.run("BEGIN TRANSACTION");
  try {
    await db.run("DELETE FROM turn_commits");
    if (ids.length > 0) {
      await db.run(
        `INSERT INTO turn_commits (turn_id, repo, sha)
         SELECT unnest($1::VARCHAR[]), unnest($2::VARCHAR[]), unnest($3::VARCHAR[])`,
        [listValue(ids), listValue(repos), listValue(shas)],
      );
    }
    await db.run("COMMIT");
  } catch (error) {
    try {
      await db.run("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
  return { attributed: ids.length };
}
