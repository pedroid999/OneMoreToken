import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_ADAPTER_VERSION, parsePi } from "@omt/adapters";
import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeFixture } from "../../../packages/adapters/opencode/fixtures/create";
import { createApp } from "../src/app";
import { defaultIngestRoots } from "../src/ingest/service";

const now = "2026-01-10T00:00:00.000Z";
const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: now });
const assistant = (id: string) =>
  JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: now,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "PRIVATE_SENTINEL" }],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    },
  });
const content = `${header}\n${assistant("a")}\n`;
let db: Database;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "omt-ingest-"));
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
function app(options: Parameters<typeof createApp>[1] = {}) {
  return createApp(db, {
    ingest: { roots: [{ agent: "pi", path: root }], now: () => now },
    ...options,
  });
}
function post(application = app(), body: unknown = {}, headers: Record<string, string> = {}) {
  return application.request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
async function stored() {
  return Promise.all(
    [
      "sources",
      "sessions",
      "turns",
      "usage",
      "tool_calls",
      "ingest_issues",
      "ingest_checkpoints",
    ].map((table) => db.all(`SELECT * FROM ${table} ORDER BY 1`)),
  );
}
const metrics = (files: number, persisted = files, skipped = 0, failed = 0, issues = 0) => ({
  files,
  persisted,
  skipped,
  failed,
  issues,
});

describe("POST /api/ingest", () => {
  it("persists metrics only, leaves source bytes/mtime unchanged and skips an identical snapshot", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(path, content);
    const before = await stat(path);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(metrics(1));
    const snapshot = await stored();
    expect(snapshot.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 0, 0, 1]);
    expect(snapshot[0]?.[0]).toMatchObject({ agent: "pi", adapter_version: PI_ADAPTER_VERSION });
    expect(snapshot[3]?.[0]).toMatchObject({ input_tokens: 10n, output_tokens: 2n });
    expect(
      JSON.stringify(snapshot, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("PRIVATE_SENTINEL");
    expect(await readFile(path, "utf8")).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(metrics(1, 0, 1));
    expect(await stored()).toEqual(snapshot);
  });

  it("reparses append/rewrite snapshots, counts a corrupt middle row and continues", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(path, content);
    await post();
    await writeFile(path, `${content}PRIVATE_SENTINEL broken\n${assistant("b")}\n`);
    const appended = await post();
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual(metrics(1, 1, 0, 0, 1));
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1, 2, 2, 0, 1, 1]);
    expect(await db.all("SELECT code, message FROM ingest_issues")).toEqual([
      { code: "invalid_json", message: "Invalid JSON record" },
    ]);
    await writeFile(path, `${header}\n`);
    expect(await (await post()).json()).toEqual(metrics(1));
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1, 0, 0, 0, 0, 1]);
  });

  it("selects by file mtime only, preserving previously persisted older snapshots", async () => {
    for (const name of ["old", "new"]) await writeFile(join(root, `${name}.jsonl`), content);
    await utimes(join(root, "old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(join(root, "new.jsonl"), new Date(now), new Date(now));
    expect(await (await post()).json()).toEqual(metrics(2));
    await writeFile(join(root, "old.jsonl"), "bad");
    await utimes(join(root, "old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
    expect(await (await post(app(), { since: now })).json()).toEqual(metrics(1, 0, 1));
    expect((await stored()).map((rows) => rows.length)).toEqual([2, 2, 2, 2, 0, 0, 2]);
  });

  it("recurses without following symlink files, directories, loops or linked-home ancestors", async () => {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "a.jsonl"), content);
    await writeFile(join(root, "ignored.txt"), content);
    await symlink(root, join(root, "nested", "loop"));
    await symlink(join(root, "nested", "a.jsonl"), join(root, "duplicate.jsonl"));
    await symlink(join(root, "nested"), join(root, "linked"));
    const application = app({
      ingest: {
        roots: [
          { agent: "pi", path: root },
          { agent: "gentle-shell", path: join(root, "linked", "sessions") },
          { agent: "claude-code", path: join(root, "absent") },
        ],
      },
    });
    expect(await (await post(application)).json()).toEqual(metrics(1));
    expect((await db.all("SELECT * FROM sources")).length).toBe(1);
  });

  it("reports absent explicit roots and read/parser errors safely, continuing other files", async () => {
    const missing = await post(app(), { agent: "pi", path: join(root, "absent") });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual(metrics(0, 0, 0, 1, 1));
    for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.jsonl`), content);
    const application = app({
      ingest: {
        roots: [{ agent: "pi", path: root }],
        fs: {
          lstat,
          readdir: (path) => readdir(path, { withFileTypes: true }),
          readFile: async (path) => {
            if (path.endsWith("a.jsonl")) throw new Error("PRIVATE_SENTINEL path/credential");
            return readFile(path, "utf8");
          },
        },
        parsers: {
          pi: (text, ctx) => {
            if (ctx.path.endsWith("b.jsonl")) throw new Error("PRIVATE_SENTINEL parser");
            return parsePi(text, ctx);
          },
        },
      },
    });
    const response = await post(application);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metrics(3, 1, 0, 2, 2));
    expect((await db.all("SELECT * FROM sources")).length).toBe(1);
  });

  it.each(["claude-code", "gentle-shell", "pi"] as const)(
    "uses the exported %s adapter",
    async (agent) => {
      const fixture = fileURLToPath(
        new URL(
          `../../../packages/adapters/${agent === "gentle-shell" ? "pi" : agent}/fixtures/session.jsonl`,
          import.meta.url,
        ),
      );
      await writeFile(join(root, "session.jsonl"), await readFile(fixture));
      const response = await post(app(), { agent, path: root });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        files: 1,
        persisted: 1,
        skipped: 0,
        failed: 0,
      });
      expect(await db.all("SELECT agent FROM sources")).toEqual([{ agent }]);
      // Pi fixtures add a compaction summary and two usage entries; a Claude compaction has no usage.
      expect((await db.all("SELECT * FROM usage")).length).toBe(agent === "claude-code" ? 2 : 5);
    },
  );

  it.each(
    [
      null,
      [],
      { agent: "other" },
      { agent: ["pi"] },
      { path: "/synthetic" },
      { agent: "pi", path: "relative" },
      { agent: "pi", path: "/bad\u0000path" },
      { since: "yesterday" },
      { since: "2026-02-30T00:00:00Z" },
      { since: 123 },
      { unknown: true },
    ].map((body) => [body]),
  )("rejects invalid input %j before filesystem/database access", async (body) => {
    const before = await stored();
    const access = vi.fn(() => {
      throw new Error("must not discover");
    });
    const application = app({
      ingest: { roots: [], fs: { lstat: access, readdir: access, readFile: access } },
    });
    const response = await post(application, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid ingest options" });
    expect(access).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it("rejects malformed/oversized JSON before ingestion and hides unexpected service errors", async () => {
    const application = app();
    const before = await stored();
    for (const body of ["{", JSON.stringify({ path: "x".repeat(17000) })]) {
      const response = await application.request("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid ingest options" });
      expect(await stored()).toEqual(before);
    }
    const failed = await post(
      app({
        ingest: {
          roots: [],
          now: () => {
            throw new Error("PRIVATE_SENTINEL");
          },
        },
      }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "ingestion failed" });
    expect(await stored()).toEqual(before);
  });

  it("blocks hostile/null Origins and non-JSON requests, accepts loopback Vite, and never enables CORS", async () => {
    await writeFile(join(root, "session.jsonl"), content);
    const before = await stored();
    for (const origin of ["https://evil.example", "null", "http://localhost.evil:5173"]) {
      const response = await post(app(), {}, { origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden origin" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await stored()).toEqual(before);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const response = await post(app(), {}, { "content-type": type });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "application/json required" });
      expect(await stored()).toEqual(before);
    }
    const accepted = await post(app(), {}, { origin: "http://localhost:5173" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(metrics(1));
    expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serializes complete concurrent ingestion requests and health reads", async () => {
    await writeFile(join(root, "a.jsonl"), content);
    await writeFile(join(root, "b.jsonl"), content);
    const application = app();
    const [first, second, health] = await Promise.all([
      post(application),
      post(application),
      application.request("/api/health"),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(metrics(2));
    expect(await second.json()).toEqual(metrics(2, 0, 2));
    expect(health.status).toBe(200);
    expect((await stored()).map((rows) => rows.length)).toEqual([2, 2, 2, 2, 0, 0, 2]);
  });
});

describe("POST /api/ingest for OpenCode", () => {
  const opencode = () =>
    app({ ingest: { roots: [{ agent: "opencode", path: root }], now: () => now } });
  async function fingerprint() {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map(async (path) => [path, (await stat(path)).mtimeMs, await readFile(path, "hex")]),
    );
  }

  it("ingests one source per session read-only, links children and skips unchanged sessions", async () => {
    await createOpenCodeFixture(root);
    const before = await fingerprint();
    const first = await post(opencode());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(metrics(4, 4, 0, 0, 2));
    expect(await fingerprint()).toEqual(before);
    expect((await readdir(root)).filter((name) => name.endsWith("-shm"))).toEqual([]);
    const snapshot = await stored();
    expect(snapshot.map((rows) => rows.length)).toEqual([4, 4, 10, 5, 4, 2, 4]);
    expect(
      JSON.stringify(snapshot, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("PRIVATE_SENTINEL");
    expect(await db.all("SELECT DISTINCT agent, adapter_version FROM sources")).toEqual([
      { agent: "opencode", adapter_version: "opencode/1" },
    ]);
    expect(
      await db.all(
        `SELECT child.format_version, parent.format_version AS parent_format
         FROM sessions child JOIN sessions parent ON child.parent_session_id = parent.id`,
      ),
    ).toEqual([
      {
        format_version: "opencode-sqlite/1.0.0-synthetic",
        parent_format: "opencode-sqlite/1.0.0-synthetic",
      },
    ]);
    expect(await db.all("SELECT format_version, cwd FROM sessions ORDER BY started_at")).toEqual([
      { format_version: "opencode-legacy/0.5.0-synthetic", cwd: "/synthetic/legacy" },
      { format_version: "opencode-sqlite/0.9.0-synthetic", cwd: "/synthetic/migrated" },
      { format_version: "opencode-sqlite/1.0.0-synthetic", cwd: "/synthetic/project" },
      { format_version: "opencode-sqlite/1.0.0-synthetic", cwd: "/synthetic/project" },
    ]);
    expect(await db.all("SELECT count(*) AS n FROM turns WHERE is_compaction")).toEqual([
      { n: 1n },
    ]);
    const second = await post(opencode());
    expect(await second.json()).toEqual(metrics(4, 0, 4));
    expect(await stored()).toEqual(snapshot);
  });

  it("accepts --agent opencode --path and filters sessions by updated time with since", async () => {
    await createOpenCodeFixture(root);
    const application = app({ ingest: { roots: [], now: () => now } });
    const response = await post(application, {
      agent: "opencode",
      path: root,
      since: "2026-01-01T00:00:00Z",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metrics(2, 2, 0, 0, 1));
    expect(await db.all("SELECT DISTINCT cwd FROM sessions")).toEqual([
      { cwd: "/synthetic/project" },
    ]);
  });

  it("counts an unreadable database as one failure and ignores an absent default root", async () => {
    await writeFile(join(root, "opencode.db"), "PRIVATE_SENTINEL not sqlite");
    expect(await (await post(opencode())).json()).toEqual(metrics(0, 0, 0, 1, 1));
    const absent = app({
      ingest: { roots: [{ agent: "opencode", path: join(root, "absent") }], now: () => now },
    });
    expect(await (await post(absent)).json()).toEqual(metrics(0));
  });

  it("discovers OpenCode under XDG_DATA_HOME, else ~/.local/share", () => {
    const find = (roots: ReturnType<typeof defaultIngestRoots>) =>
      roots.find((root) => root.agent === "opencode")?.path;
    expect(find(defaultIngestRoots("/synthetic/home", {}))).toBe(
      "/synthetic/home/.local/share/opencode",
    );
    expect(find(defaultIngestRoots("/synthetic/home", { XDG_DATA_HOME: "/synthetic/data" }))).toBe(
      "/synthetic/data/opencode",
    );
    expect(defaultIngestRoots("/synthetic/home", {}).map(({ agent }) => agent)).toEqual([
      "claude-code",
      "gentle-shell",
      "gentle-shell",
      "pi",
      "opencode",
    ]);
  });
});

describe("POST /api/ingest for gentle-shell subagents", () => {
  const fixtures = fileURLToPath(
    new URL("../../../packages/adapters/gentle-shell/fixtures/subagents/", import.meta.url),
  );
  const parentFile = "2026-01-01T00-00-00-000Z_parent-session.jsonl";
  const linkedFile = "2026-01-02T00-00-00-000Z_child-linked.jsonl";
  const orphanFile = "2026-01-03T00-00-00-000Z_child-orphan.jsonl";
  const agentDir = () => join(root, ".gentle-shell", "agent");
  const gentle = () =>
    app({
      ingest: {
        roots: defaultIngestRoots(root, { XDG_DATA_HOME: join(root, "absent") }),
        now: () => now,
      },
    });
  async function install(withParent = true) {
    const sessions = join(agentDir(), "sessions");
    const children = join(agentDir(), "gentle-agents", "sessions");
    const tasks = join(agentDir(), "gentle-agents", "tasks");
    for (const dir of [sessions, children, tasks]) await mkdir(dir, { recursive: true });
    if (withParent) {
      await writeFile(
        join(sessions, parentFile),
        await readFile(join(fixtures, "parents", parentFile)),
      );
    }
    for (const file of [linkedFile, orphanFile]) {
      await writeFile(join(children, file), await readFile(join(fixtures, "sessions", file)));
    }
    for (const name of ["task-linked", "task-resumed", "task-missing"]) {
      const file = `${name}.json`;
      await writeFile(join(tasks, file), await readFile(join(fixtures, "tasks", file)));
    }
  }
  async function fingerprint() {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .sort()
        .map(async (path) => [path, (await stat(path)).mtimeMs, await readFile(path, "hex")]),
    );
  }
  const runs = () =>
    db.all(
      `SELECT r.role, r.model, r.provider, r.effort, strftime(r.started_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS started_at,
         r.duration_ms, r.input_tokens, r.output_tokens, r.cache_read_tokens,
         r.cache_write_tokens, r.reported_cost_usd, r.computed_cost_usd,
         child.parent_session_id = r.parent_session_id AS linked, parent.format_version AS parent_format
       FROM subagent_runs r JOIN sessions child ON child.id = r.id
       JOIN sessions parent ON parent.id = r.parent_session_id`,
    );
  const run = {
    role: "gentle-ai-worker",
    model: "model-a",
    provider: "synthetic",
    effort: "high",
    started_at: "2026-01-02T00:00:00.500Z",
    duration_ms: 179500n,
    input_tokens: 110n,
    output_tokens: 25n,
    cache_read_tokens: 30n,
    cache_write_tokens: 40n,
    reported_cost_usd: 0.75,
    computed_cost_usd: null,
    linked: true,
    parent_format: "3",
  };

  it("links children to parents read-only, ignores missing sessions and skips unchanged sources", async () => {
    await install();
    const before = await fingerprint();
    const first = await post(gentle());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(metrics(3));
    expect(await fingerprint()).toEqual(before);
    expect(await runs()).toEqual([run]);
    expect(
      await db.all(
        `SELECT s.format_version, s.parent_session_id IS NULL AS root, c.adapter_version
         FROM sessions s JOIN sources c ON c.id = s.source_id ORDER BY s.started_at`,
      ),
    ).toEqual([
      { format_version: "3", root: true, adapter_version: "gentle-shell-v3/3" },
      { format_version: "pi-subagent/3", root: false, adapter_version: "gentle-shell-subagent/2" },
      { format_version: "pi-subagent/3", root: true, adapter_version: "gentle-shell-subagent/2" },
    ]);
    const snapshot = await stored();
    const all = await Promise.all(
      ["subagent_runs", "sessions", "sources", "turns", "usage", "tool_calls"].map((table) =>
        db.all(`SELECT * FROM ${table}`),
      ),
    );
    const text = JSON.stringify(all, (_key, value) =>
      typeof value === "bigint" ? String(value) : value,
    );
    expect(text).not.toContain("PRIVATE_SENTINEL");
    expect(text).not.toContain("task-");
    const second = await post(gentle());
    expect(await second.json()).toEqual(metrics(3, 0, 3));
    expect(await stored()).toEqual(snapshot);
    expect(await runs()).toEqual([run]);
  });

  it("re-links a child when its parent or task record appears later", async () => {
    await install(false);
    expect(await (await post(gentle())).json()).toEqual(metrics(2));
    expect(await db.all("SELECT count(*) AS n FROM subagent_runs")).toEqual([{ n: 0n }]);
    expect(
      await db.all("SELECT count(*) AS n FROM sessions WHERE parent_session_id IS NOT NULL"),
    ).toEqual([{ n: 0n }]);
    const sessions = join(agentDir(), "sessions");
    await writeFile(
      join(sessions, parentFile),
      await readFile(join(fixtures, "parents", parentFile)),
    );
    expect(await (await post(gentle())).json()).toEqual(metrics(3, 2, 1));
    expect(await runs()).toEqual([run]);
    const orphanTask = (
      await readFile(join(fixtures, "tasks", "task-missing.json"), "utf8")
    ).replace("2026-01-04T00-00-00-000Z_child-gone.jsonl", orphanFile);
    for (const [path] of await fingerprint()) {
      await utimes(String(path), new Date("2026-01-01"), new Date("2026-01-01"));
    }
    const tasks = join(agentDir(), "gentle-agents", "tasks");
    // A newer task record selects its older transcript under --since.
    await writeFile(join(tasks, "task-orphan.json"), orphanTask);
    expect(await (await post(gentle(), { since: now })).json()).toEqual(metrics(1, 1, 0));
    expect((await runs()).map(({ role }) => role).sort()).toEqual([
      "gentle-ai-explore",
      "gentle-ai-worker",
    ]);
    await writeFile(join(tasks, "broken.json"), "PRIVATE_SENTINEL {");
    expect(await (await post(gentle())).json()).toEqual(metrics(3, 0, 3, 1, 1));
  });

  it("snapshots profiles.json read-only and recomputes attribution after each ingest", async () => {
    await install();
    const profilesPath = join(root, ".gentle-shell", "config", "gentle-ai", "profiles.json");
    await mkdir(join(profilesPath, ".."), { recursive: true });
    await writeFile(
      profilesPath,
      JSON.stringify({
        kind: "gentle-pi.agent_model_profiles",
        version: 1,
        active: "PRIVATE_SENTINEL",
        profiles: {
          solo: {
            orchestrator: { model: "synthetic/model-a", apiKey: "PRIVATE_SENTINEL" },
            "gentle-ai-worker": { model: "synthetic/model-a", thinking: "high" },
          },
        },
      }),
    );
    const ingest = () =>
      post(
        app({
          ingest: {
            roots: defaultIngestRoots(root, { XDG_DATA_HOME: join(root, "absent") }),
            now: () => now,
            profilesPath,
          },
        }),
      );
    const attribution = () =>
      db.all(
        `SELECT s.format_version, s.parent_session_id IS NULL AS root, p.name, tp.attribution,
           count(t.id) AS turns
         FROM turns t JOIN sessions s ON s.id = t.session_id
         LEFT JOIN turn_profile tp ON tp.turn_id = t.id
         LEFT JOIN profiles p ON p.hash = tp.profile_hash
         WHERE t.model IS NOT NULL
         GROUP BY ALL ORDER BY ALL`,
      );
    const before = await fingerprint();
    expect(await (await ingest()).json()).toEqual(metrics(3));
    expect(await fingerprint()).toEqual(before);
    expect(
      await db.all(
        `SELECT name, strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS seen,
           CAST(definition AS VARCHAR) AS definition FROM profiles`,
      ),
    ).toEqual([
      {
        name: "solo",
        seen: now,
        definition: JSON.stringify({
          name: "solo",
          roles: {
            "gentle-ai-worker": { model: "synthetic/model-a", thinking: "high" },
            orchestrator: { model: "synthetic/model-a" },
          },
        }),
      },
    ]);
    // The orphan child has role unknown: never estimated.
    expect(await attribution()).toEqual([
      { format_version: "3", root: true, name: "solo", attribution: "estimated", turns: 1n },
      {
        format_version: "pi-subagent/3",
        root: false,
        name: "solo",
        attribution: "estimated",
        turns: 4n,
      },
      { format_version: "pi-subagent/3", root: true, name: null, attribution: null, turns: 1n },
    ]);

    // A bind in the parent makes it and its linked child exact; unchanged children are skipped.
    const bind = JSON.stringify({
      type: "custom",
      customType: "gentle-pi.session-profile/v1",
      id: "bind",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.500Z",
      data: {
        kind: "bind",
        origin: "user",
        name: "bound",
        modelProfiles: { orchestrator: { model: "synthetic/model-a", thinking: "high" } },
      },
    });
    const [head, ...rest] = (await readFile(join(fixtures, "parents", parentFile), "utf8"))
      .trimEnd()
      .split("\n");
    await writeFile(
      join(agentDir(), "sessions", parentFile),
      [
        head,
        bind,
        ...rest.map((line) => line.replace('"parentId":null', '"parentId":"bind"')),
      ].join("\n"),
    );
    expect(await (await ingest()).json()).toEqual(metrics(3, 1, 2));
    expect(await attribution()).toEqual([
      { format_version: "3", root: true, name: "bound", attribution: "exact", turns: 1n },
      {
        format_version: "pi-subagent/3",
        root: false,
        name: "bound",
        attribution: "exact",
        turns: 4n,
      },
      { format_version: "pi-subagent/3", root: true, name: null, attribution: null, turns: 1n },
    ]);
    const stored = JSON.stringify(
      await db.all("SELECT CAST(definition AS VARCHAR) AS d FROM profiles"),
    );
    expect(stored).not.toContain("PRIVATE_SENTINEL");
    expect(stored).not.toContain("origin");
  });

  it("does not follow a symlinked subagent directory", async () => {
    await install();
    const children = join(agentDir(), "gentle-agents", "sessions");
    await mkdir(join(root, "elsewhere"));
    await writeFile(
      join(root, "elsewhere", orphanFile),
      await readFile(join(children, orphanFile)),
    );
    await rm(children, { recursive: true });
    await symlink(join(root, "elsewhere"), children);
    expect(await (await post(gentle())).json()).toEqual(metrics(1));
  });
});
