import type { Stats } from "node:fs";
import {
  calculateCost,
  createSource,
  type Database,
  getCheckpoint,
  hashContent,
  ingestSource,
  loadPricing,
  migrate,
  openDatabase,
  type PricingFile,
  PricingFileSchema,
  persistBatch,
  recordId,
  type SourceParser,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Summary } from "../src/summary/contract";
import { readSummary } from "../src/summary/service";

let db: Database;
const from = "2026-01-01T12:00:00.000Z";
const to = "2026-01-04T00:00:00.000Z";
const query = `/api/summary?from=${from}&to=${to}`;
beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
});
async function turn(id: string, session: string, ts: string, usage = true) {
  const source = createSource({
    agent: "pi",
    path: `/synthetic/${session}.jsonl`,
    adapterVersion: "test",
    ingestedAt: from,
    pricing: loadPricing(),
  });
  const sessionId = recordId(source.id, "session", session);
  if (!(await getCheckpoint(db, source.id))) {
    await persistBatch(
      db,
      {
        source,
        sessions: [
          {
            id: sessionId,
            source_id: source.id,
            agent: "pi",
            cwd: null,
            repo: null,
            branch: null,
            started_at: from,
            ended_at: null,
            title: null,
            format_version: "test",
            parent_session_id: null,
          },
        ],
        turns: [],
        usage: [],
        toolCalls: [],
        issues: [],
      },
      hashContent("synthetic"),
      hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing()))),
    );
  }
  await db.run("INSERT INTO turns VALUES ($1, $2, 0, $3, $4, NULL, NULL, NULL, NULL, false)", [
    id,
    sessionId,
    usage ? "assistant" : "user",
    ts,
  ]);
  if (usage)
    await db.run("INSERT INTO usage VALUES ($1, 1000000, 200000, 300000, 400000, NULL, NULL)", [
      id,
    ]);
}

const reference: PricingFile = {
  version: 1,
  currency: "USD",
  basis: "current-reference",
  observedAt: "2026-10-21",
  entries: [
    {
      model: "known",
      provider: "synthetic",
      validFrom: "2026-10-21",
      validTo: null,
      inputPerMTok: 2,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
    },
  ],
};
const parser: SourceParser = (_content, context) => {
  const source = createSource(context);
  const session = recordId(source.id, "session", "s");
  const turns = ["known", "unresolved"].map((model, idx) => ({
    id: recordId(source.id, "turn", model),
    session_id: session,
    idx,
    role: "assistant",
    ts: from,
    model,
    provider: "synthetic",
    effort: null,
    subscription_id: null,
    is_compaction: false,
  }));
  return {
    source,
    sessions: [
      {
        id: session,
        source_id: source.id,
        agent: "pi",
        cwd: null,
        repo: null,
        branch: null,
        started_at: from,
        ended_at: null,
        title: null,
        format_version: "test",
        parent_session_id: null,
      },
    ],
    turns,
    usage: turns.map((turn) => {
      const tokens = {
        input_tokens: 1000000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      };
      return {
        turn_id: turn.id,
        ...tokens,
        reported_cost_usd: 0,
        computed_cost_usd: calculateCost(tokens, "synthetic", turn.model, from, context.pricing),
      };
    }),
    toolCalls: [],
    issues: [],
  };
};
const provision = (pricing: PricingFile) =>
  ingestSource(
    db,
    "synthetic",
    {
      agent: "pi",
      path: "/synthetic/priced.jsonl",
      adapterVersion: "test",
      ingestedAt: to,
      pricing,
    },
    parser,
  );

describe("GET /api/summary", () => {
  it("exposes current-reference provenance for past usage, keeping unresolved models unknown", async () => {
    await provision(reference);
    const summary = await readSummary(db, { from, to }, reference);
    expect(summary.pricing).toEqual({
      basis: "current-reference",
      observedAt: "2026-10-21",
      staleUsageTurns: 0,
    });
    expect(summary.costs).toEqual({
      reported: { usd: 0, known: 2, unknown: 0 },
      computed: { usd: 2, known: 1, unknown: 1 },
    });
    expect(summary.tokens.total).toBe(2000000);
    expect(summary.turns).toBe(2);
  });

  it("hides changed-catalog costs without writes; reingesting unchanged content restores eligibility", async () => {
    await provision(reference);
    const updated = {
      ...reference,
      entries: reference.entries.map((entry) => ({ ...entry, inputPerMTok: 3 })),
    };
    const run = vi.spyOn(db, "run");
    const response = await createApp(db).request(query);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      pricing: {
        basis: loadPricing().basis ?? "historical",
        observedAt: loadPricing().observedAt ?? null,
        staleUsageTurns: 2,
      },
      costs: {
        reported: { usd: 0, known: 2, unknown: 0 },
        computed: { usd: null, known: 0, unknown: 2 },
      },
    });
    const summary = await readSummary(db, { from, to }, updated);
    expect(run).not.toHaveBeenCalled();
    run.mockRestore();
    expect(summary.pricing.staleUsageTurns).toBe(2); // Includes the null unresolved cost.
    expect(summary.costs).toEqual({
      reported: { usd: 0, known: 2, unknown: 0 },
      computed: { usd: null, known: 0, unknown: 2 },
    });
    expect(summary.tokens.total).toBe(2000000);
    expect((await readSummary(db, { from, to }, reference)).costs.computed.usd).toBe(2);
    expect(await provision(updated)).toBe("persisted");
    const refreshed = await readSummary(db, { from, to }, updated);
    expect(refreshed.pricing.staleUsageTurns).toBe(0);
    expect(refreshed.costs.computed).toEqual({ usd: 3, known: 1, unknown: 1 });
    expect(refreshed.costs.reported).toEqual(summary.costs.reported);
    expect(refreshed.tokens).toEqual(summary.tokens);
    expect(refreshed.turns).toBe(2);
    expect(await provision(updated)).toBe("skipped");
  });

  it.each(["null checkpoint", "missing checkpoint", "missing session"])(
    "treats legacy %s costs as stale, never current-rate estimates",
    async (legacy) => {
      await provision(reference);
      if (legacy === "null checkpoint")
        await db.run("UPDATE ingest_checkpoints SET pricing_hash = NULL");
      if (legacy === "missing checkpoint") await db.run("DELETE FROM ingest_checkpoints");
      if (legacy === "missing session") await db.run("DELETE FROM sessions");
      const summary = await readSummary(db, { from, to }, reference);
      expect(summary.pricing.staleUsageTurns).toBe(2);
      expect(summary.costs.computed).toEqual({ usd: null, known: 0, unknown: 2 });
      expect(summary.costs.reported).toEqual({ usd: 0, known: 2, unknown: 0 });
      expect(summary.tokens.total).toBe(2000000);
    },
  );

  it("preserves historical catalog semantics when metadata is absent", async () => {
    const historical: PricingFile = { version: 1, currency: "USD", entries: reference.entries };
    await provision(historical);
    const summary = await readSummary(db, { from, to }, historical);
    expect(summary.pricing).toEqual({
      basis: "historical",
      observedAt: null,
      staleUsageTurns: 0,
    });
    expect(summary.costs.computed).toEqual({ usd: null, known: 0, unknown: 2 });
  });
  it("aggregates turn timestamps half-open, includes active sessions, never joins tools, and zero-fills UTC days", async () => {
    await turn("before", "old", "2026-01-01T11:59:59.999Z");
    await turn("a", "active", from);
    await turn("u", "active", "2026-01-01T13:00:00Z", false);
    await turn("b", "other", "2026-01-03T23:59:59.999Z");
    await turn("excluded", "outside", to);
    await db.run(
      "UPDATE usage SET reported_cost_usd = 0, computed_cost_usd = 2 WHERE turn_id = 'a'",
    );
    await db.run(
      "INSERT INTO tool_calls VALUES ('t1', 'a', 'read', NULL, 'ok'), ('t2', 'a', 'read', NULL, 'ok')",
    );
    await db.run(
      "INSERT INTO ingest_issues VALUES ('i', NULL, 'PRIVATE_PATH', NULL, 'warning', 'bad', 'PRIVATE_MESSAGE', $1)",
      [from],
    );
    const response = await createApp(db).request(query);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      period: { from, to },
      sessions: 2,
      turns: 3,
      usageTurns: 2,
      tokens: {
        input: 2000000,
        output: 400000,
        cacheRead: 600000,
        cacheWrite: 800000,
        total: 3800000,
      },
      pricing: {
        basis: loadPricing().basis ?? "historical",
        observedAt: loadPricing().observedAt ?? null,
        staleUsageTurns: 0,
      },
      costs: {
        reported: { usd: 0, known: 1, unknown: 1 },
        computed: { usd: 2, known: 1, unknown: 1 },
      },
      days: [
        { date: "2026-01-01", tokens: 1900000 },
        { date: "2026-01-02", tokens: 0 },
        { date: "2026-01-03", tokens: 1900000 },
      ],
      issues: { warning: 1, error: 0, critical: 0 },
      quota: { status: "unavailable" },
    } satisfies Summary);
  });

  it("defaults to a rolling seven days and returns null, not free, for absent costs", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-08T00:00:00Z"));
    const response = await createApp(db).request("/api/summary");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      period: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
      sessions: 0,
      turns: 0,
      costs: {
        reported: { usd: null, known: 0, unknown: 0 },
        computed: { usd: null, known: 0, unknown: 0 },
      },
      days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-01-0${i + 1}`, tokens: 0 })),
    });
  });

  it.each([
    "from=bad&to=bad",
    `from=${from}`,
    `to=${to}`,
    `from=${to}&to=${from}`,
    `from=${from}&to=${from}`,
    `from=2026-02-30T00:00:00Z&to=${to}`,
    "from=Infinity&to=Infinity",
    "from=2025-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",
    `from=2026-01-01&to=${to}`,
    `from=${from}&from=${to}&to=${to}`,
  ])("rejects %s before database reads and preserves stored metrics", async (search) => {
    await turn("a", "s", from);
    const before = await (await createApp(db).request(query)).json();
    const all = vi.spyOn(db, "all");
    const response = await createApp(db).request(`/api/summary?${search}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid summary period" });
    expect(all).not.toHaveBeenCalled();
    all.mockRestore();
    expect(await (await createApp(db).request(query)).json()).toEqual(before);
  });

  it("normalizes timezone offsets and allows at most 366 UTC buckets", async () => {
    const application = createApp(db);
    const response = await application.request(
      "/api/summary?from=2026-01-01T01:00:00%2B01:00&to=2027-01-02T00:00:00Z",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Summary;
    expect(body.period.from).toBe("2026-01-01T00:00:00.000Z");
    expect(body.days).toHaveLength(366);
    expect(
      (
        await application.request(
          "/api/summary?from=2026-01-01T00:00:00Z&to=2027-01-02T00:00:00.001Z",
        )
      ).status,
    ).toBe(400);
  });

  it.each([
    "input_tokens = 9007199254740992",
    "reported_cost_usd = 'Infinity'::DOUBLE",
    "computed_cost_usd = 'NaN'::DOUBLE",
  ])("rejects unsafe aggregates safely: %s", async (update) => {
    await turn("a", "s", from);
    await db.run(`UPDATE usage SET ${update}`);
    const response = await createApp(db).request(query);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "summary unavailable" });
  });

  it("queues a summary behind concurrent ingestion using the existing connection", async () => {
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
    const summary = application.request(query);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(all).not.toHaveBeenCalled();
    release();
    const ingestResponse = await ingest;
    expect(ingestResponse.status).toBe(200);
    expect(await ingestResponse.json()).toEqual({
      files: 0,
      persisted: 0,
      skipped: 0,
      failed: 0,
      issues: 0,
    });
    expect((await summary).status).toBe(200);
    all.mockRestore();
    expect(await (await application.request("/api/health")).json()).toEqual({
      status: "ok",
      schemaVersion: 7,
    });
  });
});
