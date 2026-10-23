import type { Stats } from "node:fs";
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
import type { ExplorerResponse } from "../src/explorer/contract";

let db: Database;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";
const currentHash = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

async function session(id: string, source: string, agent: string, branch: string | null) {
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at, title, format_version, parent_session_id)
     VALUES ($1, $2, $3, '/private/cwd', NULL, $4, $5, NULL, NULL, 'test', NULL)`,
    [id, source, agent, branch, from],
  );
}
async function turn(
  id: string,
  sessionId: string,
  ts: string,
  model: string | null,
  effort: string | null,
  usage?: [number, number, number, number, number | null, number | null],
  tools: string[] = [],
) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id, is_compaction)
     VALUES ($1, $2, 0, $3, $4, $5, $6, $7, NULL, false)`,
    [id, sessionId, usage ? "assistant" : "user", ts, model, model ? "p" : null, effort],
  );
  if (usage) await db.run("INSERT INTO usage VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, ...usage]);
  for (const [i, tool] of tools.entries())
    await db.run("INSERT INTO tool_calls VALUES ($1, $2, $3, NULL, 'ok')", [
      `${id}-${i}`,
      id,
      tool,
    ]);
}

/** Two sessions; s2's checkpoint was priced with another catalog, so its computed cost is stale. */
async function seed() {
  await db.run(
    `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at, pricing_hash)
     VALUES ('src1', 'h', 'test', $1, $2), ('src2', 'h', 'test', $1, 'old')`,
    [from, currentHash],
  );
  await session("s1", "src1", "claude-code", "main");
  await session("s2", "src2", "pi", null);
  await turn("t0", "s1", "2025-12-31T23:59:59.999Z", "m-a", "high", [9, 9, 9, 9, 9, 9]);
  // t1 calls read twice and edit once: one turn, two distinct tools.
  await turn("t1", "s1", from, "m-a", "high", [100, 20, 300, 80, 0.5, 1], ["read", "edit", "read"]);
  await turn("t2", "s1", "2026-01-01T11:00:00Z", null, null);
  await turn("t3", "s2", "2026-01-02T23:30:00Z", "m-b", null, [0, 10, 0, 0, null, 2], ["read"]);
  await turn("t4", "s2", to, "m-b", null, [7, 7, 7, 7, 7, 7], ["read"]);
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await seed();
});
afterEach(() => {
  db.close();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  createApp(db).request("/api/explorer/query", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const query = (body: Record<string, unknown>) =>
  post({ metrics: ["turns"], dimensions: [], filters: [], from, to, ...body });
async function rows(body: Record<string, unknown>) {
  const response = await query(body);
  expect(response.status).toBe(200);
  return ((await response.json()) as ExplorerResponse).rows;
}

describe("POST /api/explorer/query metrics (S6, L16 metrics)", () => {
  it("sums token categories once per turn over the half-open turn range", async () => {
    const response = await query({ metrics: ["input", "output", "cacheRead", "cacheWrite"] });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      columns: [
        { name: "input", type: "metric" },
        { name: "output", type: "metric" },
        { name: "cacheRead", type: "metric" },
        { name: "cacheWrite", type: "metric" },
      ],
      rows: [{ input: 100, output: 30, cacheRead: 300, cacheWrite: 80 }],
      unavailable: [],
      overlapping: false,
      truncated: false,
    } satisfies ExplorerResponse);
  });

  it("counts total, turns (including user turns), distinct sessions and the cache hit ratio", async () => {
    expect(await rows({ metrics: ["total", "turns", "sessions", "cacheHitRatio"] })).toEqual([
      { total: 510, turns: 3, sessions: 2, cacheHitRatio: 300 / 480 },
    ]);
  });

  it("returns known-only cost sums with known/unknown counts; stale pricing is unknown", async () => {
    const response = await query({ metrics: ["computedCost", "reportedCost"] });
    const body = (await response.json()) as ExplorerResponse;
    expect(body.columns).toEqual([
      { name: "computedCost", type: "metric" },
      { name: "reportedCost", type: "metric" },
      { name: "computedCostKnown", type: "coverage" },
      { name: "computedCostUnknown", type: "coverage" },
      { name: "reportedCostKnown", type: "coverage" },
      { name: "reportedCostUnknown", type: "coverage" },
    ]);
    expect(body.rows).toEqual([
      {
        computedCost: 1,
        reportedCost: 0.5,
        computedCostKnown: 1,
        computedCostUnknown: 1,
        reportedCostKnown: 1,
        reportedCostUnknown: 1,
      },
    ]);
  });

  it("returns null, never zero, for unknown costs and an empty cache hit denominator", async () => {
    expect(
      await rows({
        metrics: ["cacheHitRatio", "reportedCost"],
        dimensions: ["agent"],
      }),
    ).toEqual([
      {
        agent: "claude-code",
        cacheHitRatio: 300 / 480,
        reportedCost: 0.5,
        reportedCostKnown: 1,
        reportedCostUnknown: 0,
      },
      {
        agent: "pi",
        cacheHitRatio: null,
        reportedCost: null,
        reportedCostKnown: 0,
        reportedCostUnknown: 1,
      },
    ]);
  });

  it("returns a zero row with null ratios and costs for an empty range", async () => {
    expect(
      await rows({
        metrics: ["total", "cacheHitRatio", "computedCost", "sessions"],
        from: "2027-01-01T00:00:00Z",
        to: "2027-01-02T00:00:00Z",
      }),
    ).toEqual([
      {
        total: 0,
        cacheHitRatio: null,
        computedCost: null,
        computedCostKnown: 0,
        computedCostUnknown: 0,
        sessions: 0,
      },
    ]);
  });
});

describe("POST /api/explorer/query dimensions (S7, L16 dimensions)", () => {
  it.each([
    [
      "agent",
      [
        { agent: "claude-code", turns: 2 },
        { agent: "pi", turns: 1 },
      ],
    ],
    [
      "model",
      [
        { model: "m-a", turns: 1 },
        { model: "m-b", turns: 1 },
        { model: null, turns: 1 },
      ],
    ],
    [
      "provider",
      [
        { provider: "p", turns: 2 },
        { provider: null, turns: 1 },
      ],
    ],
    [
      "effort",
      [
        { effort: "high", turns: 1 },
        { effort: null, turns: 2 },
      ],
    ],
    ["repo", [{ repo: null, turns: 3 }]],
    [
      "branch",
      [
        { branch: "main", turns: 2 },
        { branch: null, turns: 1 },
      ],
    ],
    [
      "day",
      [
        { day: "2026-01-01", turns: 2 },
        { day: "2026-01-02", turns: 1 },
      ],
    ],
    [
      "hourOfDay",
      [
        { hourOfDay: 0, turns: 1 },
        { hourOfDay: 11, turns: 1 },
        { hourOfDay: 23, turns: 1 },
      ],
    ],
    // ISO weekday in UTC: 2026-01-01 is a Thursday (4).
    [
      "dayOfWeek",
      [
        { dayOfWeek: 4, turns: 2 },
        { dayOfWeek: 5, turns: 1 },
      ],
    ],
  ])("groups by %s", async (dimension, expected) => {
    const response = await query({ dimensions: [dimension] });
    const body = (await response.json()) as ExplorerResponse;
    expect(body.rows).toEqual(expected);
    expect(body.columns[0]).toEqual({ name: dimension, type: "dimension" });
    expect(body.unavailable).toEqual([]);
  });

  it.each(["subscription", "profile", "role"])(
    "reports %s as unavailable and groups it as null, never guessed",
    async (dimension) => {
      const response = await query({ dimensions: [dimension, "agent"] });
      const body = (await response.json()) as ExplorerResponse;
      expect(body.unavailable).toEqual([dimension]);
      expect(body.rows).toEqual([
        { [dimension]: null, agent: "claude-code", turns: 2 },
        { [dimension]: null, agent: "pi", turns: 1 },
      ]);
    },
  );

  it("counts a turn once per distinct tool and flags overlapping totals", async () => {
    const response = await query({ metrics: ["turns", "input"], dimensions: ["tool"] });
    const body = (await response.json()) as ExplorerResponse;
    expect(body.overlapping).toBe(true);
    expect(body.rows).toEqual([
      { tool: "edit", turns: 1, input: 100 },
      { tool: "read", turns: 2, input: 100 },
      { tool: null, turns: 1, input: 0 },
    ]);
    const agents = (await (await query({ dimensions: ["agent"] })).json()) as ExplorerResponse;
    expect(agents.overlapping).toBe(false);
  });

  it("crosses two dimensions", async () => {
    expect(await rows({ dimensions: ["agent", "tool"] })).toEqual([
      { agent: "claude-code", tool: "edit", turns: 1 },
      { agent: "claude-code", tool: "read", turns: 1 },
      { agent: "claude-code", tool: null, turns: 1 },
      { agent: "pi", tool: "read", turns: 1 },
    ]);
  });

  it("truncates to the limit and says so", async () => {
    const response = await query({ dimensions: ["agent"], limit: 1 });
    const body = (await response.json()) as ExplorerResponse;
    expect(body.rows).toEqual([{ agent: "claude-code", turns: 2 }]);
    expect(body.truncated).toBe(true);
  });
});

describe("POST /api/explorer/query filters and range (S9, L16 filters)", () => {
  it("combines filters with AND; notIn keeps null groups", async () => {
    expect(
      await rows({
        metrics: ["turns", "input"],
        filters: [
          { dimension: "agent", op: "in", values: ["claude-code"] },
          { dimension: "model", op: "notIn", values: ["m-a"] },
        ],
      }),
    ).toEqual([{ turns: 1, input: 0 }]);
  });

  it("filters by tool per turn without duplicating turns that call it twice", async () => {
    expect(
      await rows({
        metrics: ["turns", "input"],
        filters: [{ dimension: "tool", op: "in", values: ["read", "edit"] }],
      }),
    ).toEqual([{ turns: 2, input: 100 }]);
    expect(await rows({ filters: [{ dimension: "tool", op: "notIn", values: ["read"] }] })).toEqual(
      [{ turns: 1 }],
    );
  });

  it("filters tool groups when grouping by tool", async () => {
    expect(
      await rows({
        dimensions: ["tool"],
        filters: [{ dimension: "tool", op: "in", values: ["read"] }],
      }),
    ).toEqual([{ tool: "read", turns: 2 }]);
  });

  it("matches numeric time dimensions by their decimal text", async () => {
    expect(
      await rows({
        dimensions: ["day"],
        filters: [
          { dimension: "hourOfDay", op: "in", values: ["23"] },
          { dimension: "dayOfWeek", op: "in", values: ["5"] },
        ],
      }),
    ).toEqual([{ day: "2026-01-02", turns: 1 }]);
  });

  it("treats unavailable dimensions as null in filters", async () => {
    expect(await rows({ filters: [{ dimension: "role", op: "in", values: ["build"] }] })).toEqual([
      { turns: 0 },
    ]);
    expect(
      await rows({ filters: [{ dimension: "role", op: "notIn", values: ["build"] }] }),
    ).toEqual([{ turns: 3 }]);
  });

  it("selects by turn timestamp, inclusive from and exclusive to, after offset normalization", async () => {
    expect(
      await rows({ from: "2025-12-31T23:59:59.999Z", to: "2026-01-01T00:00:00.001Z" }),
    ).toEqual([{ turns: 2 }]);
    expect(await rows({ from: "2026-01-03T01:00:00+01:00", to: "2026-01-04T00:00:00Z" })).toEqual([
      { turns: 1 },
    ]);
  });

  it("binds injection-looking values instead of executing them", async () => {
    const run = vi.spyOn(db, "run");
    expect(
      await rows({
        dimensions: ["agent"],
        filters: [
          {
            dimension: "agent",
            op: "in",
            values: ["x' OR 1=1 --", "'); DROP TABLE turns; --", 'claude-code" OR "1"="1'],
          },
        ],
      }),
    ).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    run.mockRestore();
    expect(await rows({})).toEqual([{ turns: 3 }]);
  });
});

describe("POST /api/explorer/query rejection", () => {
  const valid = { metrics: ["turns"], dimensions: [], filters: [], from, to };
  it.each([
    ["unknown metric", { ...valid, metrics: ["tokens"] }],
    ["SQL in a metric", { ...valid, metrics: ["turns; DROP TABLE turns"] }],
    ["unknown dimension", { ...valid, dimensions: ["user"] }],
    ["unknown op", { ...valid, filters: [{ dimension: "agent", op: "like", values: ["%"] }] }],
    [
      "unknown filter dimension",
      { ...valid, filters: [{ dimension: "cwd", op: "in", values: ["/"] }] },
    ],
    ["empty filter values", { ...valid, filters: [{ dimension: "agent", op: "in", values: [] }] }],
    [
      "too many filter values",
      { ...valid, filters: [{ dimension: "agent", op: "in", values: Array(51).fill("a") }] },
    ],
    [
      "non-string filter value",
      { ...valid, filters: [{ dimension: "agent", op: "in", values: [1] }] },
    ],
    ["no metrics", { ...valid, metrics: [] }],
    [
      "five metrics",
      { ...valid, metrics: ["input", "output", "cacheRead", "cacheWrite", "total"] },
    ],
    ["duplicate metric", { ...valid, metrics: ["turns", "turns"] }],
    ["three dimensions", { ...valid, dimensions: ["agent", "model", "day"] }],
    ["duplicate dimension", { ...valid, dimensions: ["agent", "agent"] }],
    ["extra key", { ...valid, sql: "SELECT 1" }],
    ["missing to", { ...valid, to: undefined }],
    ["invalid from", { ...valid, from: "bad" }],
    ["date without time", { ...valid, from: "2026-01-01" }],
    ["reversed range", { ...valid, from: to, to: from }],
    ["empty range", { ...valid, to: from }],
    [
      "span above 366 UTC days",
      { ...valid, from: "2025-01-01T00:00:00Z", to: "2026-01-03T00:00:00Z" },
    ],
    ["zero limit", { ...valid, limit: 0 }],
    ["huge limit", { ...valid, limit: 100001 }],
    ["array body", [valid]],
    ["malformed JSON", "{"],
    ["oversized body", { ...valid, padding: "x".repeat(70 * 1024) }],
  ])("rejects %s before database reads and preserves stored data", async (_label, body) => {
    const before = await rows({ metrics: ["total", "turns", "sessions"] });
    const all = vi.spyOn(db, "all");
    const run = vi.spyOn(db, "run");
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid explorer query" });
    expect(all).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    all.mockRestore();
    run.mockRestore();
    expect(await rows({ metrics: ["total", "turns", "sessions"] })).toEqual(before);
  });

  it("requires JSON, a local Host and no hostile browser Origin", async () => {
    const all = vi.spyOn(db, "all");
    const text = await createApp(db).request("/api/explorer/query", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(valid),
    });
    expect(text.status).toBe(415);
    const origin = await post(valid, { origin: "https://evil.example" });
    expect(origin.status).toBe(403);
    expect(await origin.json()).toEqual({ error: "forbidden origin" });
    const host = await post(valid, { host: "evil.example" });
    expect(host.status).toBe(403);
    expect(await host.json()).toEqual({ error: "forbidden host" });
    expect(all).not.toHaveBeenCalled();
    all.mockRestore();
  });

  it("fails safely on unsafe aggregates", async () => {
    await db.run("UPDATE usage SET reported_cost_usd = 'NaN'::DOUBLE WHERE turn_id = 't1'");
    const response = await query({ metrics: ["reportedCost"] });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "explorer unavailable" });
  });
});

describe("POST /api/explorer/query queueing", () => {
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
    const explorer = application.request("/api/explorer/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metrics: ["turns"], dimensions: [], filters: [], from, to }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(all).not.toHaveBeenCalled();
    release();
    expect((await ingest).status).toBe(200);
    const response = await explorer;
    expect(response.status).toBe(200);
    expect(((await response.json()) as ExplorerResponse).rows).toEqual([{ turns: 3 }]);
    all.mockRestore();
  });
});
