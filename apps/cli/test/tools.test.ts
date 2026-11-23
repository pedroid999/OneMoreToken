import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { ToolsReport } from "../src/tools/contract";

let db: Database;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";
const currentHash = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

async function session(id: string, source: string, agent: string) {
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at, title,
      format_version, parent_session_id)
     VALUES ($1, $2, $3, NULL, NULL, NULL, $4, NULL, NULL, 'test', NULL)`,
    [id, source, agent, from],
  );
}

type Usage = [number, number, number, number, number | null, number | null];
async function turn(
  id: string,
  sessionId: string,
  ts: string,
  usage?: Usage,
  tools: [string, "ok" | "error", number | null][] = [],
) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id,
      is_compaction)
     VALUES ($1, $2, 0, $3, $4, $5, $6, NULL, NULL, false)`,
    [id, sessionId, usage ? "assistant" : "user", ts, usage ? "m-a" : null, usage ? "p" : null],
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

/**
 * `pi` and `codex` sessions. Raw names cover every shape the catalogue has to resolve: the same tool
 * spelled two ways in one session, a name that maps only through an alias, a call inside a turn that
 * shared the tool with another, a call without a duration and a call without usage.
 */
async function seed() {
  await db.run(
    `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at,
      pricing_hash)
     VALUES ('src1', 'h', 'test', $1, $2), ('src2', 'h', 'test', $1, $2)`,
    [from, currentHash],
  );
  await session("s1", "src1", "pi");
  await session("s2", "src2", "codex");
  // Two raw spellings of `read` plus an error in the same turn.
  await turn(
    "t1",
    "s1",
    "2026-01-01T10:00:00Z",
    [100, 20, 30, 40, 0.5, 1],
    [
      ["Read", "ok", 10],
      ["read", "ok", 20],
      ["Edit", "error", 5],
    ],
  );
  // A duration-less call, and `grep` alone in a turn without usage.
  await turn("t2", "s1", "2026-01-02T10:00:00Z", [10, 5, 0, 0, null, 0.25], [["Read", "ok", null]]);
  await turn("t4", "s1", "2026-01-02T11:00:00Z", undefined, [["grep", "ok", null]]);
  // Codex records no tool error status: `exec` is `bash` and `Read` is `read`.
  await turn(
    "t3",
    "s2",
    "2026-01-01T12:00:00Z",
    [7, 3, 0, 0, null, 0.5],
    [
      ["exec", "ok", 100],
      ["Read", "ok", null],
    ],
  );
  // Outside the period.
  await turn("t0", "s1", "2025-12-31T23:59:59.999Z", [9, 9, 9, 9, 9, 9], [["Write", "ok", 7]]);
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await seed();
});
afterEach(() => {
  db.close();
});

const get = (path = "/api/tools") => createApp(db).request(path);
const period = `?from=${from}&to=${to}`;
async function body(): Promise<ToolsReport> {
  const response = await get(`/api/tools${period}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ToolsReport;
}

describe("GET /api/tools (spec §7.1.8, §7.3, phase 5 L3)", () => {
  it("returns the period and one row per canonical tool, no-store", async () => {
    const response = await get(`/api/tools${period}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const tools = (await response.json()) as ToolsReport;
    expect(tools.period).toEqual({ from, to });
    expect(tools.tools.map((row) => row.tool)).toEqual(["bash", "edit", "grep", "read"]);
  });

  it("groups by canonical name and keeps every raw spelling visible", async () => {
    const tools = await body();
    const read = tools.tools.find((row) => row.tool === "read");
    expect(read?.rawNames).toEqual(["Read", "read"]);
    expect(read?.calls).toBe(4);
    expect(read?.errors).toBe(0);
    expect(tools.tools.find((row) => row.tool === "bash")?.rawNames).toEqual(["exec"]);
    expect(tools.tools.find((row) => row.tool === "edit")?.rawNames).toEqual(["Edit"]);
  });

  it("counts calls, errors and durations per call", async () => {
    const tools = await body();
    const read = tools.tools.find((row) => row.tool === "read");
    // Two of the four calls carry a duration.
    expect(read?.durationKnownMs).toBe(30);
    expect(read?.durationAvgKnownMs).toBe(15);
    const grep = tools.tools.find((row) => row.tool === "grep");
    expect(grep).toMatchObject({ calls: 1, durationKnownMs: 0, durationAvgKnownMs: null });
    expect(tools.tools.find((row) => row.tool === "edit")).toMatchObject({
      calls: 1,
      errors: 1,
      durationKnownMs: 5,
      durationAvgKnownMs: 5,
    });
    // The call outside the period is never counted.
    expect(tools.tools.map((row) => row.tool)).not.toContain("write");
  });

  it("sums the tokens and costs of the turns that used the tool, overlapping across rows", async () => {
    const tools = await body();
    const read = tools.tools.find((row) => row.tool === "read");
    expect(read).toMatchObject({
      turns: 3,
      // t1 (`read` + `edit`) and t3 (`bash` + `read`) shared their turns.
      sharedTurns: 2,
      tokens: { input: 117, output: 28, cacheRead: 30, cacheWrite: 40, total: 215 },
      computedCostUsd: 1.75,
      reportedCostUsd: 0.5,
      costKnownTurns: 3,
      costUnknownTurns: 0,
    });
    expect(tools.tools.find((row) => row.tool === "edit")).toMatchObject({
      turns: 1,
      sharedTurns: 1,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, total: 190 },
      computedCostUsd: 1,
      reportedCostUsd: 0.5,
    });
    // A turn without usage contributes no tokens and no known cost.
    expect(tools.tools.find((row) => row.tool === "grep")).toMatchObject({
      turns: 1,
      sharedTurns: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      computedCostUsd: null,
      reportedCostUsd: null,
      costKnownTurns: 0,
      costUnknownTurns: 1,
    });
    // A tool used by an agent without error status is unknown, never 0 %.
    expect(read?.errorStatusKnown).toBe(false);
    expect(tools.tools.find((row) => row.tool === "bash")).toMatchObject({
      calls: 1,
      errors: 0,
      errorStatusKnown: false,
    });
    expect(tools.tools.find((row) => row.tool === "edit")?.errorStatusKnown).toBe(true);
  });

  it("keeps the daily pace turn-level and restricted to the tools it lists", async () => {
    const tools = await body();
    expect(tools.daily).toEqual([
      { day: "2026-01-01", tool: "bash", tokens: 10 },
      { day: "2026-01-01", tool: "edit", tokens: 190 },
      { day: "2026-01-01", tool: "read", tokens: 200 },
      { day: "2026-01-02", tool: "grep", tokens: 0 },
      { day: "2026-01-02", tool: "read", tokens: 15 },
    ]);
  });

  it("keeps the raw name and the agent of every mapping so it can be audited", async () => {
    const tools = await body();
    expect(tools.byAgent).toEqual([
      {
        agent: "codex",
        rawName: "exec",
        tool: "bash",
        calls: 1,
        errors: 0,
        errorStatusKnown: false,
      },
      { agent: "pi", rawName: "Edit", tool: "edit", calls: 1, errors: 1, errorStatusKnown: true },
      { agent: "pi", rawName: "grep", tool: "grep", calls: 1, errors: 0, errorStatusKnown: true },
      {
        agent: "codex",
        rawName: "Read",
        tool: "read",
        calls: 1,
        errors: 0,
        errorStatusKnown: false,
      },
      { agent: "pi", rawName: "Read", tool: "read", calls: 2, errors: 0, errorStatusKnown: true },
      { agent: "pi", rawName: "read", tool: "read", calls: 1, errors: 0, errorStatusKnown: true },
    ]);
  });

  it("narrows every figure to the requested period", async () => {
    const response = await get(
      "/api/tools?from=2026-01-02T00:00:00.000Z&to=2026-01-03T00:00:00.000Z",
    );
    expect(response.status).toBe(200);
    const tools = (await response.json()) as ToolsReport;
    expect(tools.tools.map((row) => row.tool)).toEqual(["grep", "read"]);
    expect(tools.tools.find((row) => row.tool === "read")).toMatchObject({
      calls: 1,
      turns: 1,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      computedCostUsd: 0.25,
    });
  });

  it("defaults to the rolling seven days like the Summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    try {
      const response = await get("/api/tools");
      expect(response.status).toBe(200);
      const tools = (await response.json()) as ToolsReport;
      expect(tools.period).toEqual({
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-01-08T00:00:00.000Z",
      });
      expect(tools.tools.map((row) => row.tool)).toEqual(["bash", "edit", "grep", "read"]);
      // The 2025-12-31 call stays outside the window.
      expect(tools.byAgent.map((row) => row.rawName)).not.toContain("Write");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["only from", "/api/tools?from=2026-01-01T00:00:00.000Z"],
    ["only to", "/api/tools?to=2026-01-03T00:00:00.000Z"],
    ["repeated from", `/api/tools?from=${from}&from=${from}&to=${to}`],
    ["malformed", "/api/tools?from=yesterday&to=2026-01-03T00:00:00.000Z"],
    ["reversed", "/api/tools?from=2026-01-03T00:00:00.000Z&to=2026-01-01T00:00:00.000Z"],
  ])("rejects an invalid period (%s) with 400 before any read", async (_label, path) => {
    const all = vi.spyOn(db, "all");
    const run = vi.spyOn(db, "run");
    const response = await get(path);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid tools period" });
    expect(all).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    all.mockRestore();
    run.mockRestore();
  });

  it("fails closed on corrupt stored figures with a fixed diagnostic", async () => {
    await db.run("UPDATE usage SET input_tokens = 9007199254740992");
    const response = await get(`/api/tools${period}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "tools unavailable" });
  });
});
