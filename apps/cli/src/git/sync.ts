import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  type Database,
  GIT_LOG_FORMAT,
  parseGitLog,
  type Row,
  upsertRepoCommits,
  upsertSessionRepos,
} from "@omt/core";

const run = promisify(execFile);
const DAY = 86400000;

/** Inherited `GIT_*` variables (e.g. `GIT_DIR`, `GIT_WORK_TREE` when omt runs from a git hook)
 * would override `-C`; only the global/system config switches are kept. */
const KEPT_GIT_ENV = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]);
function inheritedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_") || KEPT_GIT_ENV.has(key)),
  );
}

/**
 * Read-only git: no shell, no optional locks (so `git` never refreshes the index), no prompts, no
 * lazy fetch of missing objects and no transport at all, so it never touches the network. Diffs
 * ignore external tools and textconv filters. Any failure means "no data" for that call.
 */
async function git(dir: string, args: string[], timeout = 10_000): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", dir, "-c", "protocol.allow=never", "-c", "log.showSignature=false", ...args],
      {
        env: {
          ...inheritedEnv(),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
        },
        timeout,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Links sessions to git repositories and stores the user's commits (L14 (1)-(2)). Each distinct
 * session cwd (a child without one inherits its nearest ancestor's) resolves to its toplevel;
 * non-repos and missing directories are skipped silently. Per repository, `git log --branches`
 * starts one day before its earliest session. Pull request merges map the stored commits in
 * `M^1..M^2`; a commit in several (a release merge repeats them) keeps the earliest merge.
 * The caller owns the writer queue; the repositories are never written.
 */
export async function syncGitRepos(db: Database): Promise<void> {
  const sessions = await db.all(
    "SELECT id, cwd, parent_session_id, epoch_ms(started_at) AS started FROM sessions",
  );
  const byId = new Map(sessions.map((row) => [String(row.id), row]));
  const cwdOf = (id: string): string | null => {
    const seen = new Set<string>();
    for (let row = byId.get(id); row && !seen.has(String(row.id)); ) {
      seen.add(String(row.id));
      if (typeof row.cwd === "string" && isAbsolute(row.cwd)) return row.cwd;
      row = row.parent_session_id ? byId.get(String(row.parent_session_id)) : undefined;
    }
    return null;
  };

  const toplevels = new Map<string, string | null>();
  const links: Row<"session_repos">[] = [];
  const earliest = new Map<string, number>();
  for (const row of sessions) {
    const id = String(row.id);
    const cwd = cwdOf(id);
    if (!cwd) continue;
    if (!toplevels.has(cwd)) {
      const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
      const top = out?.trim();
      toplevels.set(cwd, top && isAbsolute(top) ? top : null);
    }
    const repo = toplevels.get(cwd);
    if (!repo) continue;
    links.push({ session_id: id, repo });
    const started = Number(row.started);
    if (Number.isFinite(started))
      earliest.set(repo, Math.min(earliest.get(repo) ?? started, started));
  }
  await upsertSessionRepos(db, links);

  for (const [repo, started] of [...earliest].sort(([a], [b]) => a.localeCompare(b))) {
    const email = (await git(repo, ["config", "--get", "user.email"]))?.trim();
    if (!email) continue;
    const output = await git(
      repo,
      [
        "log",
        "--branches",
        "--numstat",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        GIT_LOG_FORMAT,
        `--since=${new Date(started - DAY).toISOString()}`,
      ],
      120_000,
    );
    if (output === null) continue;
    const { commits, merges } = parseGitLog(output, repo, email);
    const stored = new Set(commits.map((commit) => commit.sha));
    const pullRequests = new Map<string, Row<"commit_pull_requests">>();
    const ordered = [...merges].sort(
      (a, b) => a.authoredAt.localeCompare(b.authoredAt) || a.pullRequest - b.pullRequest,
    );
    for (const merge of ordered) {
      const range = await git(repo, ["rev-list", `${merge.firstParent}..${merge.secondParent}`]);
      for (const sha of range?.split("\n") ?? []) {
        if (stored.has(sha) && !pullRequests.has(sha))
          pullRequests.set(sha, { repo, sha, pr_number: merge.pullRequest });
      }
    }
    await upsertRepoCommits(db, commits, [...pullRequests.values()]);
  }
}
