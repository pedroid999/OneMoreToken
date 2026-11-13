import { CommitSchema, type Row } from "../schema/tables";

/** `git log` arguments whose output `parseGitLog` reads: one record per commit (record separator),
 * header fields split by the unit separator, then `--numstat` lines. Merges print no numstat. */
export const GIT_LOG_FORMAT = "--format=%x1e%H%x1f%P%x1f%aI%x1f%ae%x1f%s";

export interface GitMerge {
  sha: string;
  /** From the subject `Merge pull request #N …`. */
  pullRequest: number;
  firstParent: string;
  secondParent: string;
  authoredAt: string;
}
export interface ParsedGitLog {
  /** The user's non-merge commits; `author` is always null (no names or emails are stored). */
  commits: Row<"commits">[];
  /** Pull request merges, whoever authored them. */
  merges: GitMerge[];
}

const PULL_REQUEST = /^Merge pull request #(\d+) /;

/**
 * Parses `git log GIT_LOG_FORMAT --numstat` output for one repository (L14 (2)). Only commits whose
 * author email equals `userEmail` are kept, with the subject line as message and binary files
 * counted as 0 lines. Merge commits carry no diff of their own and are not stored; those named
 * `Merge pull request #N` are returned to map their pull request. Malformed records are skipped.
 */
export function parseGitLog(output: string, repo: string, userEmail: string): ParsedGitLog {
  const commits: Row<"commits">[] = [];
  const merges: GitMerge[] = [];
  for (const record of output.split("\x1e")) {
    const [header = "", ...lines] = record.split("\n");
    const [sha, parentList, authored, email, ...subject] = header.split("\x1f");
    const at = Date.parse(authored ?? "");
    if (!sha || parentList === undefined || !Number.isFinite(at)) continue;
    const parents = parentList.split(" ").filter(Boolean);
    const message = subject.join("\x1f");
    const authoredAt = new Date(at).toISOString();
    if (parents.length > 1) {
      const pullRequest = Number(PULL_REQUEST.exec(message)?.[1]);
      const [firstParent, secondParent] = parents;
      if (Number.isSafeInteger(pullRequest) && pullRequest > 0 && firstParent && secondParent)
        merges.push({ sha, pullRequest, firstParent, secondParent, authoredAt });
      continue;
    }
    if (email !== userEmail) continue;
    let additions = 0;
    let deletions = 0;
    for (const line of lines) {
      const [added, deleted] = line.split("\t");
      if (deleted === undefined) continue;
      // Binary files print `-` for both counts.
      additions += /^\d+$/.test(added ?? "") ? Number(added) : 0;
      deletions += /^\d+$/.test(deleted) ? Number(deleted) : 0;
    }
    const row = CommitSchema.safeParse({
      repo,
      sha,
      authored_at: authoredAt,
      author: null,
      message,
      additions,
      deletions,
    });
    if (row.success) commits.push(row.data);
  }
  return { commits, merges };
}
