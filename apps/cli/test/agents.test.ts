import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentsReport } from "../src/agents/contract";
import { createApp } from "../src/app";

let db: Database;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";
const currentHash = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

async function session(id: string, agent: string) {
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at, title,
      format_version, parent_session_id)
     VALUES ($1, 'src', $2, NULL, NULL, NULL, $3, NULL, NULL, 'test', NULL)`,
    [id, agent, from],
  );
}

type Usage = [number, number, number, number, number | null, number | null];
async function turn(id: string, sessionId: string, ts: string, usage?: Usage) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id,
      is_compaction)
     VALUES ($1, $2, 0, $3, $4, $5, $6, NULL, NULL, false)`,
    [id, sessionId, usage ? "assistant" : "user", ts, usage ? "m-a" : null, usage ? "p" : null],
  );
  if (usage) await db.run("INSERT INTO usage VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, ...usage]);
}

/**
 * One session per class and source: derived `feature` (subagent run), derived `inline` (resolved
 * repository), derived `unknown` (no evidence), and two corrected sessions, one of which also has a
 * repository, so derivation never leaks into the corrected row.
 */
async function seed() {
  await db.run(
    `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at,
      pricing_hash)
     VALUES ('src', 'h', 'test', $1, $2)`,
    [from, currentHash],
  );
  await session("s1", "pi");
  await session("s2", "claude-code");
  await session("s3", "opencode");
  await session("s4", "pi");
  await session("s5", "pi");
  await db.run("INSERT INTO session_repos VALUES ('s1', '/synthetic/one')");
  await db.run(
    `INSERT INTO subagent_runs (id, parent_session_id, role) VALUES ('r1', 's2', 'build')`,
  );
  await db.run("INSERT INTO session_repos VALUES ('s5', '/synthetic/five')");
  await db.run(
    "INSERT INTO session_task_classes (session_id, task_class) VALUES ('s4', 'feature')",
  );
  await db.run(
    "INSERT INTO session_task_classes (session_id, task_class) VALUES ('s5', 'feature')",
  );
  await turn("t1", "s1", "2026-01-01T10:00:00Z", [100, 20, 30, 40, 0.5, 1]);
  await turn("t2", "s2", "2026-01-01T11:00:00Z", [10, 5, 0, 0, null, 0.25]);
  await turn("t3", "s3", "2026-01-01T12:00:00Z", [0, 0, 0, 0, null, 0]);
  await turn("t4", "s4", "2026-01-01T13:00:00Z", [6, 4, 0, 0, 0.1, 0.2]);
  await turn("t5", "s5", "2026-01-01T14:00:00Z", [1, 1, 1, 1, null, null]);
  // Outside the period: never counted, but the session still belongs to its class row.
  await turn("t0", "s1", "2025-12-31T23:00:00Z", [9, 9, 9, 9, 9, 9]);
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await seed();
});
afterEach(() => {
  db.close();
});

const get = (path = "/api/agents") => createApp(db).request(path);
const period = `?from=${from}&to=${to}`;
async function body(path = `/api/agents${period}`): Promise<AgentsReport> {
  const response = await get(path);
  expect(response.status).toBe(200);
  return (await response.json()) as AgentsReport;
}

describe("GET /api/agents (spec §7.1.6, §7.3, phase 5 L3)", () => {
  it("returns the period, the closed class vocabulary and no-store", async () => {
    const response = await get(`/api/agents${period}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const agents = (await response.json()) as AgentsReport;
    expect(agents.period).toEqual({ from, to });
    expect(agents.classes).toEqual(["feature", "inline", "unknown"]);
  });

  it("compares agents by task class, keeping derived and corrected sessions apart", async () => {
    const agents = await body();
    expect(agents.rows).toEqual([
      {
        taskClass: "feature",
        source: "derived",
        agent: "claude-code",
        sessions: 1,
        turns: 1,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        computedCostUsd: 0.25,
        reportedCostUsd: null,
        cacheHitRatio: 0,
      },
      {
        taskClass: "feature",
        source: "corrected",
        agent: "pi",
        sessions: 2,
        turns: 2,
        tokens: { input: 7, output: 5, cacheRead: 1, cacheWrite: 1, total: 14 },
        computedCostUsd: 0.2,
        reportedCostUsd: 0.1,
        cacheHitRatio: 1 / 9,
      },
      {
        taskClass: "inline",
        source: "derived",
        agent: "pi",
        sessions: 1,
        turns: 1,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, total: 190 },
        computedCostUsd: 1,
        reportedCostUsd: 0.5,
        cacheHitRatio: 30 / 170,
      },
      {
        taskClass: "unknown",
        source: "derived",
        agent: "opencode",
        sessions: 1,
        turns: 1,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        computedCostUsd: 0,
        reportedCostUsd: null,
        // No tokens means no ratio: unknown, never 0.
        cacheHitRatio: null,
      },
    ]);
    expect(agents.totals).toEqual({ derivedSessions: 3, correctedSessions: 2 });
  });

  it("moves a session to the corrected rows as soon as its class is overridden", async () => {
    await db.run(
      "INSERT INTO session_task_classes (session_id, task_class) VALUES ('s1', 'feature')",
    );
    const agents = await body();
    expect(agents.rows.map((row) => [row.taskClass, row.source, row.agent])).toEqual([
      ["feature", "derived", "claude-code"],
      ["feature", "corrected", "pi"],
      ["unknown", "derived", "opencode"],
    ]);
    expect(agents.rows.find((row) => row.source === "corrected")).toMatchObject({
      sessions: 3,
      turns: 3,
    });
    expect(agents.totals).toEqual({ derivedSessions: 2, correctedSessions: 3 });
  });

  it("counts a session once even when only some of its turns fall in the period", async () => {
    const agents = await body();
    const inline = agents.rows.find((row) => row.taskClass === "inline");
    // t0 (9 tokens) sits 1 ms before `from`.
    expect(inline).toMatchObject({ sessions: 1, turns: 1, tokens: { total: 190 } });
    expect(agents.totals.derivedSessions + agents.totals.correctedSessions).toBe(5);
  });

  it("returns empty rows and totals for a period without turns", async () => {
    const agents = await body(
      `/api/agents?from=2026-02-01T00:00:00.000Z&to=2026-02-02T00:00:00.000Z`,
    );
    expect(agents.rows).toEqual([]);
    expect(agents.totals).toEqual({ derivedSessions: 0, correctedSessions: 0 });
  });

  it("defaults to the rolling seven days like the Summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    try {
      const response = await get("/api/agents");
      expect(response.status).toBe(200);
      expect(((await response.json()) as AgentsReport).period).toEqual({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-08T00:00:00.000Z",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["only from", "/api/agents?from=2026-01-01T00:00:00.000Z"],
    ["only to", "/api/agents?to=2026-01-03T00:00:00.000Z"],
    ["malformed", "/api/agents?from=yesterday&to=2026-01-03T00:00:00.000Z"],
    ["reversed", "/api/agents?from=2026-01-03T00:00:00.000Z&to=2026-01-01T00:00:00.000Z"],
  ])("rejects an invalid period (%s) with 400 before any read", async (_label, path) => {
    const all = vi.spyOn(db, "all");
    const run = vi.spyOn(db, "run");
    const response = await get(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid agents period" });
    expect(all).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    all.mockRestore();
    run.mockRestore();
  });

  it("fails closed on corrupt stored figures with a fixed diagnostic", async () => {
    await db.run("UPDATE usage SET output_tokens = 9007199254740992");
    const response = await get(`/api/agents${period}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "agents unavailable" });
  });
});
