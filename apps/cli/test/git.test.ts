import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { parsePi } from "@omt/adapters";
import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const ME = "me@example.invalid";
let db: Database;
let root: string;
let repo: string;
let sessions: string;

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "omt-git-"));
  repo = join(root, "repo-a");
  sessions = join(root, "sessions");
  await mkdir(sessions);
  // Neither the tests nor the code under test may read the real global or system git config.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(async () => {
  db.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], date?: string, author?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      ...(author ? { GIT_AUTHOR_NAME: "Other", GIT_AUTHOR_EMAIL: author } : {}),
    },
  }).trim();
}
async function commit(message: string, date: string, files: Record<string, string | Buffer>) {
  for (const [name, body] of Object.entries(files)) await writeFile(join(repo, name), body);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message], date);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Commits of the shared scenario (UTC, 2 March 2026 unless noted). */
async function createRepo() {
  await mkdir(repo);
  git(root, ["init", "-q", "-b", "main", repo]);
  git(repo, ["config", "user.email", ME]);
  git(repo, ["config", "user.name", "Me"]);
  const old = await commit("chore: old", "2026-02-20T09:00:00Z", { "old.txt": "old\n" });
  const one = await commit("feat: one", "2026-03-02T10:05:00Z", { "a.txt": "1\n2\n3\n" });
  await writeFile(join(repo, "b.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "feat: other"], "2026-03-02T10:20:00Z", "other@example.invalid");
  git(repo, ["checkout", "-q", "-b", "x/y"]);
  const two = await commit("feat: two\n\nPRIVATE_SENTINEL body", "2026-03-02T10:30:00Z", {
    "c.txt": "a\nb\n",
    "bin.dat": Buffer.from([0, 1, 2, 0, 255, 0]),
  });
  git(repo, ["checkout", "-q", "main"]);
  git(
    repo,
    ["merge", "-q", "--no-ff", "x/y", "-m", "Merge pull request #7 from x/y"],
    "2026-03-02T10:35:00Z",
  );
  const three = await commit("fix: three", "2026-03-02T10:45:00Z", { "a.txt": "1\n2\n" });
  const late = await commit("feat: late", "2026-03-02T12:00:00Z", { "d.txt": "d\n" });
  await mkdir(join(repo, "sub"));
  return { old, one, two, three, late };
}

const piSession = (id: string, started: string, cwd: string | null, turns: [string, number][]) =>
  `${[
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: started,
      ...(cwd ? { cwd } : {}),
    }),
    ...turns.map(([ts, input], index) =>
      JSON.stringify({
        type: "message",
        id: `${id}-${index}`,
        parentId: null,
        timestamp: ts,
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "PRIVATE_SENTINEL" }],
          // Reported cost = tokens / 1000; the model has no catalog price, so computed is null.
          usage: {
            input,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: input,
            cost: { total: input / 1000 },
          },
        },
      }),
    ),
  ].join("\n")}\n`;

/** Sessions of the shared scenario: a parent in a repo subdirectory, its child without a cwd, a
 * non-repo directory and a missing directory. */
async function createSessions() {
  await mkdir(join(root, "plain"));
  const day = "2026-03-02T";
  await writeFile(
    join(sessions, "a-parent.jsonl"),
    piSession("parent", `${day}09:58:00Z`, join(repo, "sub"), [
      [`${day}10:00:00Z`, 12],
      [`${day}10:10:00Z`, 120],
      [`${day}10:40:00Z`, 1200],
      [`${day}11:00:00Z`, 5],
    ]),
  );
  await writeFile(
    join(sessions, "b-child.jsonl"),
    piSession("child", `${day}10:41:00Z`, null, [[`${day}10:42:00Z`, 10]]),
  );
  await writeFile(
    join(sessions, "c-plain.jsonl"),
    piSession("plain", `${day}09:59:00Z`, join(root, "plain"), [[`${day}10:00:00Z`, 50]]),
  );
  await writeFile(
    join(sessions, "d-missing.jsonl"),
    piSession("missing", `${day}09:59:30Z`, join(root, "absent"), [[`${day}10:00:00Z`, 60]]),
  );
}

function app() {
  let parentId: string | undefined;
  return createApp(db, {
    ingest: {
      roots: [{ agent: "pi", path: sessions }],
      now: () => "2026-03-03T00:00:00.000Z",
      parsers: {
        // Pi has no parent link of its own: the child points at the parent parsed just before it.
        pi: (text, context) => {
          const batch = parsePi(text, context);
          const session = batch.sessions[0];
          if (session && context.path.endsWith("a-parent.jsonl")) parentId = session.id;
          if (session && context.path.endsWith("b-child.jsonl"))
            session.parent_session_id = parentId ?? null;
          return batch;
        },
      },
    },
    quotas: { now: () => Date.parse("2026-03-03T00:00:00Z") },
  });
}
const ingest = (application = app()) =>
  application.request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
const PERIOD = "from=2026-03-01T00:00:00Z&to=2026-03-03T00:00:00Z";

/** Every file under the repository (`.git` included) with size, mtime and content hash. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await stat(path);
    if (entry.isDirectory()) {
      out.push(`${relative(repo, path)}/ ${info.mtimeMs}`, ...(await tree(path)));
    } else {
      const hash = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      out.push(`${relative(repo, path)} ${info.size} ${info.mtimeMs} ${hash}`);
    }
  }
  return out.sort();
}
const gitTables = () =>
  Promise.all(
    ["commits", "session_repos", "commit_pull_requests", "turn_commits"].map((table) =>
      db.all(`SELECT * FROM ${table} ORDER BY ALL`),
    ),
  );
async function sessionIds() {
  const rows = await db.all(
    "SELECT s.id, src.path FROM sessions s JOIN sources src ON src.id = s.source_id",
  );
  return Object.fromEntries(rows.map((row) => [basename(String(row.path)), String(row.id)]));
}

describe("git ingest and GET /api/git", () => {
  it("stores the user's commits read-only, links sessions and attributes each turn to the next commit", async () => {
    const shas = await createRepo();
    await createSessions();
    const before = await tree(repo);
    const refs = git(repo, ["for-each-ref"]);

    const response = await ingest();
    expect(response.status).toBe(200);
    // Git data never changes the ingest metrics.
    expect(await response.json()).toEqual({
      files: 4,
      persisted: 4,
      skipped: 0,
      failed: 0,
      issues: 0,
    });

    const top = await realpath(repo);
    const ids = await sessionIds();
    expect(await db.all("SELECT * FROM commits ORDER BY authored_at")).toEqual(
      [
        [shas.one, "2026-03-02T10:05:00Z", "feat: one", 3, 0],
        [shas.two, "2026-03-02T10:30:00Z", "feat: two", 2, 0],
        [shas.three, "2026-03-02T10:45:00Z", "fix: three", 0, 1],
        [shas.late, "2026-03-02T12:00:00Z", "feat: late", 1, 0],
      ].map(([sha, at, message, additions, deletions]) => ({
        repo: top,
        sha,
        authored_at: new Date(String(at)),
        author: null,
        message,
        additions,
        deletions,
      })),
    );
    expect(await db.all("SELECT * FROM session_repos ORDER BY session_id")).toEqual(
      [ids["a-parent.jsonl"], ids["b-child.jsonl"]]
        .sort()
        .map((session_id) => ({ session_id, repo: top })),
    );
    expect(await db.all("SELECT * FROM commit_pull_requests")).toEqual([
      { repo: top, sha: shas.two, pr_number: 7 },
    ]);
    expect((await db.all("SELECT * FROM turn_commits")).length).toBe(4);
    const stored = JSON.stringify(await gitTables(), (_key, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    expect(stored).not.toMatch(/example\.invalid|Other|PRIVATE_SENTINEL/);

    // Read-only: no file, mtime or ref of the repository changed.
    expect(await tree(repo)).toEqual(before);
    expect(git(repo, ["for-each-ref"])).toBe(refs);

    const git_ = await app().request(`/api/git?${PERIOD}`);
    expect(git_.status).toBe(200);
    expect(git_.headers.get("cache-control")).toBe("no-store");
    const commitRow = (
      sha: string,
      subject: string,
      authoredAt: string,
      additions: number,
      deletions: number,
      tokens: number,
      cost: number | null,
      sessionsCount: number,
      pullRequest: number | null,
    ) => ({
      repo: "repo-a",
      sha: sha.slice(0, 7),
      subject,
      authoredAt,
      additions,
      deletions,
      tokens,
      computedCostUsd: null,
      reportedCostUsd: cost === null ? null : expect.closeTo(cost, 12),
      sessions: sessionsCount,
      pullRequest,
    });
    const day = "2026-03-02T";
    expect(await git_.json()).toEqual({
      commits: [
        commitRow(shas.one, "feat: one", `${day}10:05:00.000Z`, 3, 0, 12, 0.012, 1, null),
        commitRow(shas.two, "feat: two", `${day}10:30:00.000Z`, 2, 0, 120, 0.12, 1, 7),
        commitRow(shas.three, "fix: three", `${day}10:45:00.000Z`, 0, 1, 1210, 1.21, 2, null),
        commitRow(shas.late, "feat: late", `${day}12:00:00.000Z`, 1, 0, 0, null, 0, null),
      ],
      pullRequests: [
        {
          number: 7,
          repo: "repo-a",
          commits: 1,
          additions: 2,
          deletions: 0,
          tokens: 120,
          computedCostUsd: null,
          reportedCostUsd: expect.closeTo(0.12, 12),
        },
      ],
      orphanSessions: [
        {
          sessionId: ids["a-parent.jsonl"],
          agent: "pi",
          repo: "repo-a",
          startedAt: `${day}09:58:00.000Z`,
          tokens: 5,
          computedCostUsd: null,
          reportedCostUsd: expect.closeTo(0.005, 12),
          hadCommit: true,
        },
        {
          sessionId: ids["c-plain.jsonl"],
          agent: "pi",
          repo: null,
          startedAt: `${day}09:59:00.000Z`,
          tokens: 50,
          computedCostUsd: null,
          reportedCostUsd: expect.closeTo(0.05, 12),
          hadCommit: false,
        },
        {
          sessionId: ids["d-missing.jsonl"],
          agent: "pi",
          repo: null,
          startedAt: `${day}09:59:30.000Z`,
          tokens: 60,
          computedCostUsd: null,
          reportedCostUsd: expect.closeTo(0.06, 12),
          hadCommit: false,
        },
      ],
    });
  });

  it("is idempotent on re-ingest and keeps commits of repos no longer seen", async () => {
    await createRepo();
    await createSessions();
    await ingest();
    const first = await gitTables();
    const second = await ingest();
    expect(await second.json()).toEqual({
      files: 4,
      persisted: 0,
      skipped: 4,
      failed: 0,
      issues: 0,
    });
    expect(await gitTables()).toEqual(first);

    await rm(repo, { recursive: true, force: true });
    await ingest();
    expect(await gitTables()).toEqual(first);
  });

  it("does not attribute a turn to a commit later than the session end plus 30 minutes", async () => {
    await createRepo();
    const day = "2026-03-02T";
    await writeFile(
      join(sessions, "late.jsonl"),
      piSession("late", `${day}11:00:00Z`, repo, [[`${day}11:20:00Z`, 9]]),
    );
    await ingest();
    expect(await db.all("SELECT * FROM turn_commits")).toEqual([]);
    const response = await app().request(`/api/git?${PERIOD}`);
    const body = (await response.json()) as { orphanSessions: unknown };
    expect(body.orphanSessions).toEqual([
      expect.objectContaining({ repo: "repo-a", tokens: 9, hadCommit: false }),
    ]);
  });

  it("counts a commit once when several clones of the repository hold it", async () => {
    await createRepo();
    const clone = join(root, "clone", "repo-a");
    await mkdir(join(root, "clone"));
    git(root, ["clone", "-q", "--no-local", repo, clone]);
    git(clone, ["config", "user.email", ME]);
    const day = "2026-03-02T";
    await writeFile(
      join(sessions, "one.jsonl"),
      piSession("one", `${day}10:00:00Z`, repo, [[`${day}10:04:00Z`, 7]]),
    );
    await writeFile(
      join(sessions, "two.jsonl"),
      piSession("two", `${day}10:01:00Z`, clone, [[`${day}10:03:00Z`, 30]]),
    );
    await ingest();
    const response = await app().request(`/api/git?${PERIOD}`);
    const body = (await response.json()) as {
      commits: { sha: string; tokens: number; additions: number; sessions: number }[];
    };
    const shas = body.commits.map((row) => row.sha);
    expect(new Set(shas).size).toBe(shas.length);
    const first = body.commits.find((row) => row.tokens > 0);
    expect(first).toMatchObject({ tokens: 37, additions: 3, sessions: 2 });
  });

  it("ignores inherited GIT_DIR and GIT_WORK_TREE and reads the session's own repository", async () => {
    await createRepo();
    const decoy = join(root, "decoy");
    await mkdir(decoy);
    git(root, ["init", "-q", "-b", "main", decoy]);
    vi.stubEnv("GIT_DIR", join(decoy, ".git"));
    vi.stubEnv("GIT_WORK_TREE", decoy);
    const day = "2026-03-02T";
    await writeFile(
      join(sessions, "env.jsonl"),
      piSession("env", `${day}10:00:00Z`, repo, [[`${day}10:04:00Z`, 7]]),
    );
    await ingest();
    const response = await app().request(`/api/git?${PERIOD}`);
    const body = (await response.json()) as { commits: { repo: string; tokens: number }[] };
    expect(body.commits.length).toBeGreaterThan(0);
    expect(new Set(body.commits.map((row) => row.repo))).toEqual(new Set(["repo-a"]));
    expect(body.commits.reduce((total, row) => total + row.tokens, 0)).toBe(7);
  });

  it.each([
    "from=2026-03-01",
    "from=2026-03-02T00:00:00.000Z&to=2026-03-01T00:00:00.000Z",
    "from=x&to=y",
  ])("rejects an invalid period %s", async (query) => {
    const response = await app().request(`/api/git?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid git period" });
  });

  it("fails closed on corrupt stored figures", async () => {
    await createSessions();
    await ingest();
    await db.run("UPDATE usage SET reported_cost_usd = 'NaN'::DOUBLE");
    const response = await app().request(`/api/git?${PERIOD}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "git unavailable" });
  });
});
