import type { Stats } from "node:fs";
import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
  recordId,
  sourceFileId,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { SessionDetail, SessionList } from "../src/sessions/contract";

let db: Database;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";
const currentHash = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));
const PRIVATE_CWD = "/Users/private-person/secret-client/project-x";

const source = (name: string) => sourceFileId("pi", `/synthetic/${name}.jsonl`);
const sid = (name: string) => recordId(source(name), "session", name);
const PARENT = sid("parent");
const CHILD = sid("child");
const OTHER = sid("other");
const OLD = sid("old");
const ORPHAN = sid("orphan");

async function session(
  name: string,
  agent: string,
  started: string,
  parent: string | null = null,
  cwd: string | null = PRIVATE_CWD,
  pricingHash: string = currentHash,
) {
  await db.run(
    `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at, pricing_hash)
     VALUES ($1, 'h', 'test', $2, $3)`,
    [source(name), from, pricingHash],
  );
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at, title, format_version, parent_session_id)
     VALUES ($1, $2, $3, $4, NULL, 'main', $5, '2026-01-02T00:00:00Z', 'PRIVATE TITLE', 'test', $6)`,
    [sid(name), source(name), agent, cwd, started, parent],
  );
}

type Usage = [number, number, number, number, number | null, number | null];
async function turn(
  name: string,
  session: string,
  idx: number,
  role: string,
  ts: string,
  usage?: Usage,
  tools: [string, "ok" | "error", number | null][] = [],
  compaction = false,
) {
  const id = recordId(source(session), "turn", name);
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id, is_compaction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9)`,
    [
      id,
      sid(session),
      idx,
      role,
      ts,
      usage ? "m-a" : null,
      usage ? "p" : null,
      usage ? "high" : null,
      compaction,
    ],
  );
  if (usage) await db.run("INSERT INTO usage VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, ...usage]);
  for (const [i, [tool, status, duration]] of tools.entries())
    await db.run("INSERT INTO tool_calls VALUES ($1, $2, $3, $4, $5)", [
      `${id}:tool:${i}`,
      id,
      tool,
      duration,
      status,
    ]);
}

/** parent (claude-code) has a child (pi) and an orphan child whose parent is absent. */
async function seed() {
  await session("parent", "claude-code", "2026-01-01T10:00:00Z");
  await session("child", "pi", "2026-01-01T12:00:00Z", PARENT, "C:\\Users\\private\\child-dir");
  await session("other", "pi", "2026-01-02T08:00:00Z", null, null, "old-catalog");
  await session("old", "pi", "2025-12-01T00:00:00Z");
  await session("orphan", "opencode", "2026-01-01T09:00:00Z", sid("missing"), "/a/b/");
  // Inserted out of idx order on purpose.
  await turn(
    "p2",
    "parent",
    2,
    "assistant",
    "2026-01-01T10:02:00Z",
    [100, 20, 300, 80, 0.5, 1],
    [
      ["read", "ok", 10],
      ["edit", "error", 5],
      ["read", "ok", null],
    ],
  );
  await turn("p0", "parent", 0, "user", "2026-01-01T10:00:00Z");
  await turn("p3", "parent", 3, "compaction", "2026-01-01T10:03:00Z", undefined, [], true);
  await turn("p1", "parent", 1, "assistant", "2026-01-01T10:01:00Z", [10, 5, 0, 0, null, 0.25]);
  // Outside the period (exclusive end): only the detail includes it.
  await turn("p4", "parent", 4, "assistant", to, [1, 1, 1, 1, 1, 1]);
  await turn(
    "c0",
    "child",
    0,
    "assistant",
    "2026-01-01T12:00:00Z",
    [7, 3, 0, 0, null, null],
    [["bash", "ok", 100]],
  );
  await turn("o0", "other", 0, "assistant", "2026-01-02T23:59:59.999Z", [1, 2, 3, 4, 0, 9]);
  await turn("x0", "old", 0, "assistant", "2025-12-31T23:59:59.999Z", [1, 1, 1, 1, 1, 1]);
  await turn("r0", "orphan", 0, "user", "2026-01-01T09:00:00Z");
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await seed();
});
afterEach(() => {
  db.close();
});

const get = (path: string) => createApp(db).request(path);
const list = `/api/sessions?from=${from}&to=${to}`;
async function listBody(search = ""): Promise<SessionList> {
  const response = await get(`${list}${search}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionList;
}
async function detailBody(id: string): Promise<SessionDetail> {
  const response = await get(`/api/sessions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionDetail;
}

describe("GET /api/sessions (S10, L21 API: list)", () => {
  it("lists sessions with turns in the half-open period, newest first, with period-scoped stats", async () => {
    const response = await get(list);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SessionList;
    expect(body.period).toEqual({ from, to });
    expect(body.truncated).toBe(false);
    expect(body.sessions.map((s) => s.id)).toEqual([OTHER, CHILD, PARENT, ORPHAN]);
    // OLD only has a turn 1 ms before `from`.
    expect(body.sessions.map((s) => s.id)).not.toContain(OLD);
    expect(body.sessions[2]).toEqual({
      id: PARENT,
      agent: "claude-code",
      cwd: "project-x",
      branch: "main",
      startedAt: "2026-01-01T10:00:00.000Z",
      endedAt: "2026-01-02T00:00:00.000Z",
      parentId: null,
      turns: 4,
      usageTurns: 2,
      tokens: { input: 110, output: 25, cacheRead: 300, cacheWrite: 80, total: 515 },
      costs: {
        reported: { usd: 0.5, known: 1, unknown: 1 },
        computed: { usd: 1.25, known: 2, unknown: 0 },
      },
      compactions: 1,
      children: 1,
    });
    expect(body.pricing).toEqual({
      basis: loadPricing().basis ?? "historical",
      observedAt: loadPricing().observedAt ?? null,
    });
  });

  it("keeps costs known-only: stale pricing and absent costs are unknown, never zero", async () => {
    const body = await listBody();
    const other = body.sessions.find((s) => s.id === OTHER);
    expect(other?.costs).toEqual({
      reported: { usd: 0, known: 1, unknown: 0 },
      computed: { usd: null, known: 0, unknown: 1 },
    });
    const child = body.sessions.find((s) => s.id === CHILD);
    expect(child?.costs).toEqual({
      reported: { usd: null, known: 0, unknown: 1 },
      computed: { usd: null, known: 0, unknown: 1 },
    });
    const orphan = body.sessions.find((s) => s.id === ORPHAN);
    expect(orphan).toMatchObject({
      parentId: sid("missing"),
      cwd: "b",
      turns: 1,
      usageTurns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      costs: {
        reported: { usd: null, known: 0, unknown: 0 },
        computed: { usd: null, known: 0, unknown: 0 },
      },
    });
    expect(child).toMatchObject({ parentId: PARENT, cwd: "child-dir", children: 0 });
    expect(other?.cwd).toBeNull();
  });

  it("filters by agent and bounds the list with a limit", async () => {
    expect((await listBody("&agent=pi")).sessions.map((s) => s.id)).toEqual([OTHER, CHILD]);
    expect((await listBody("&agent=gentle-shell")).sessions).toEqual([]);
    const limited = await listBody("&limit=2");
    expect(limited.sessions.map((s) => s.id)).toEqual([OTHER, CHILD]);
    expect(limited.truncated).toBe(true);
    expect((await listBody("&limit=4")).truncated).toBe(false);
  });

  it("defaults to the rolling seven days like the Summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    try {
      const response = await get("/api/sessions");
      expect(response.status).toBe(200);
      const body = (await response.json()) as SessionList;
      expect(body.period).toEqual({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-08T00:00:00.000Z",
      });
      expect(body.sessions.map((s) => s.id)).toContain(PARENT);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "from=bad&to=bad",
    `from=${from}`,
    `from=${to}&to=${from}`,
    "from=2025-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",
    `from=${from}&to=${to}&agent=codex`,
    `from=${from}&to=${to}&agent=`,
    `from=${from}&to=${to}&agent=pi&agent=pi`,
    `from=${from}&to=${to}&limit=0`,
    `from=${from}&to=${to}&limit=501`,
    `from=${from}&to=${to}&limit=1.5`,
    `from=${from}&to=${to}&limit=-1`,
    `from=${from}&to=${to}&limit=01`,
    `from=${from}&to=${to}&limit=2&limit=3`,
  ])("rejects %s before database reads and leaves stored data unchanged", async (search) => {
    const before = await listBody();
    const all = vi.spyOn(db, "all");
    const run = vi.spyOn(db, "run");
    const response = await get(`/api/sessions?${search}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid sessions query" });
    expect(all).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    all.mockRestore();
    run.mockRestore();
    expect(await listBody()).toEqual(before);
  });

  it("rejects unsafe aggregates with a fixed diagnostic", async () => {
    await db.run("UPDATE usage SET input_tokens = 9007199254740992");
    const response = await get(list);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "sessions unavailable" });
  });
});

describe("GET /api/sessions/:id (S10, L21 API: detail and context curve)", () => {
  it("returns the session with whole-session stats and turns in idx order", async () => {
    const response = await get(`/api/sessions/${PARENT}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as SessionDetail;
    expect(body.session).toMatchObject({
      id: PARENT,
      agent: "claude-code",
      cwd: "project-x",
      turns: 5,
      usageTurns: 3,
      tokens: { input: 111, output: 26, cacheRead: 301, cacheWrite: 81, total: 519 },
      costs: {
        reported: { usd: 1.5, known: 2, unknown: 1 },
        computed: { usd: 2.25, known: 3, unknown: 0 },
      },
      compactions: 1,
      children: 1,
    });
    expect(body.turns.map((t) => t.idx)).toEqual([0, 1, 2, 3, 4]);
    expect(body.turns[2]).toEqual({
      idx: 2,
      role: "assistant",
      ts: "2026-01-01T10:02:00.000Z",
      model: "m-a",
      provider: "p",
      effort: "high",
      isCompaction: false,
      tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 80 },
      contextTokens: 480,
      costs: { reported: 0.5, computed: 1 },
      tools: [
        { tool: "read", status: "ok", durationMs: 10 },
        { tool: "edit", status: "error", durationMs: 5 },
        { tool: "read", status: "ok", durationMs: null },
      ],
    });
  });

  it("sets context size to input + cache read + cache write, null without usage", async () => {
    const body = await detailBody(PARENT);
    expect(body.turns.map((t) => [t.role, t.isCompaction, t.contextTokens])).toEqual([
      ["user", false, null],
      ["assistant", false, 10],
      ["assistant", false, 480],
      ["compaction", true, null],
      ["assistant", false, 3],
    ]);
    expect(body.turns[0]).toMatchObject({
      tokens: null,
      costs: { reported: null, computed: null },
    });
    expect(body.turns[1]?.costs).toEqual({ reported: null, computed: 0.25 });
  });

  it("links the parent and the children with their stats", async () => {
    const parent = await detailBody(PARENT);
    expect(parent.parent).toBeNull();
    expect(parent.children).toEqual([
      {
        id: CHILD,
        agent: "pi",
        startedAt: "2026-01-01T12:00:00.000Z",
        turns: 1,
        usageTurns: 1,
        tokens: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
        costs: {
          reported: { usd: null, known: 0, unknown: 1 },
          computed: { usd: null, known: 0, unknown: 1 },
        },
      },
    ]);
    const child = await detailBody(CHILD);
    expect(child.parent).toEqual({ id: PARENT, agent: "claude-code" });
    expect(child.children).toEqual([]);
    expect(child.turns[0]?.tools).toEqual([{ tool: "bash", status: "ok", durationMs: 100 }]);
    // A parent that was never ingested keeps its id, without an agent.
    expect((await detailBody(ORPHAN)).parent).toEqual({ id: sid("missing"), agent: null });
  });

  it("marks stale-priced computed costs unknown per turn", async () => {
    const body = await detailBody(OTHER);
    expect(body.turns[0]?.costs).toEqual({ reported: 0, computed: null });
    expect(body.session.costs.computed).toEqual({ usd: null, known: 0, unknown: 1 });
  });

  it("returns 404 for a well-formed unknown id", async () => {
    const response = await get(`/api/sessions/${sid("nobody")}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "session not found" });
  });

  it.each([
    "s1",
    `${PARENT}x`,
    PARENT.toUpperCase(),
    PARENT.replace(":session:", ":turn:"),
    `${PARENT}'%20OR%20'1'='1`,
    "%00",
  ])("rejects malformed id %s before database reads", async (id) => {
    const before = await detailBody(PARENT);
    const all = vi.spyOn(db, "all");
    const run = vi.spyOn(db, "run");
    const response = await get(`/api/sessions/${id}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid session id" });
    expect(all).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    all.mockRestore();
    run.mockRestore();
    expect(await detailBody(PARENT)).toEqual(before);
  });

  it("accepts a percent-encoded id", async () => {
    const response = await get(`/api/sessions/${encodeURIComponent(PARENT)}`);
    expect(response.status).toBe(200);
  });
});

describe("sessions API privacy (L21: cwd basename only, metrics only)", () => {
  it("never returns the full working directory, source paths or titles", async () => {
    const bodies = [
      await (await get(list)).text(),
      ...(await Promise.all(
        [PARENT, CHILD, OTHER, ORPHAN].map(async (id) => (await get(`/api/sessions/${id}`)).text()),
      )),
    ];
    for (const text of bodies) {
      expect(text).not.toContain("private-person");
      expect(text).not.toContain("secret-client");
      expect(text).not.toContain("Users");
      expect(text).not.toContain("/synthetic");
      expect(text).not.toContain("PRIVATE TITLE");
    }
  });

  it("is behind the Host guard", async () => {
    const response = await createApp(db).request(list, { headers: { host: "evil.example" } });
    expect(response.status).toBe(403);
  });
});

describe("sessions API queueing", () => {
  it("waits behind a concurrent ingestion on the same connection", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const application = createApp(db, {
      ingest: {
        roots: [{ agent: "pi", path: "/synthetic" }],
        fs: {
          lstat: async () => ({ isSymbolicLink: () => false, isDirectory: () => true }) as Stats,
          readdir: async () => {
            started();
            await gate;
            return [];
          },
          readFile: async () => {
            throw new Error("must not read source data");
          },
        },
      },
    });
    const all = vi.spyOn(db, "all");
    const ingest = application.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await entered;
    const listed = application.request(list);
    const detail = application.request(`/api/sessions/${PARENT}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(all).not.toHaveBeenCalled();
    release();
    expect((await ingest).status).toBe(200);
    expect((await listed).status).toBe(200);
    expect((await detail).status).toBe(200);
    all.mockRestore();
  });
});
