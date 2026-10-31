import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  calculateCost,
  createIssue,
  createSource,
  type Database,
  getCheckpoint,
  hashContent,
  ingestSource,
  migrate,
  type NormalizedBatch,
  openDatabase,
  type ParseContext,
  persistBatch,
  recordId,
  sourceFileId,
} from "../src/index";

const context: ParseContext = {
  agent: "pi",
  path: "/synthetic/session.jsonl",
  adapterVersion: "1",
  ingestedAt: "2026-01-01T00:00:00Z",
  pricing: { version: 1, currency: "USD", entries: [] },
};
function batch(ctx = context): NormalizedBatch {
  const source = createSource(ctx);
  const session = recordId(source.id, "session", "native-session");
  const turn = recordId(source.id, "turn", "native-turn");
  return {
    source,
    sessions: [
      {
        id: session,
        source_id: source.id,
        agent: ctx.agent,
        cwd: null,
        repo: null,
        branch: null,
        started_at: ctx.ingestedAt,
        ended_at: null,
        title: null,
        format_version: "3",
        parent_session_id: null,
      },
    ],
    turns: [
      {
        id: turn,
        session_id: session,
        idx: 0,
        role: "assistant",
        ts: ctx.ingestedAt,
        model: "synthetic",
        provider: "synthetic",
        effort: null,
        subscription_id: null,
        is_compaction: false,
      },
    ],
    usage: [
      {
        turn_id: turn,
        input_tokens: 10,
        output_tokens: 20,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        reported_cost_usd: 0,
        computed_cost_usd: null,
      },
    ],
    toolCalls: [
      {
        id: recordId(source.id, "tool", "native-tool"),
        turn_id: turn,
        tool: "read",
        duration_ms: null,
        status: "ok",
      },
    ],
    issues: [createIssue(source, "invalid_json", "2", ctx.ingestedAt)],
  };
}

function fixtureRow<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected a fixture row");
  return row;
}

let db: Database;
beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(() => db.close());
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

describe("metrics-only ingestion", () => {
  it("persists validated metrics and reported zero, and skips unchanged normalization", async () => {
    let calls = 0;
    const parse = (_text: string, ctx: ParseContext) => {
      calls++;
      return batch(ctx);
    };
    expect(await getCheckpoint(db, createSource(context).id)).toBeNull();
    expect(await ingestSource(db, "synthetic", context, parse)).toBe("persisted");
    const before = await stored();
    expect(before.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(before[3]?.[0]).toMatchObject({ reported_cost_usd: 0, computed_cost_usd: null });
    expect(await getCheckpoint(db, createSource(context).id)).toEqual({
      source_id: createSource(context).id,
      content_hash: hashContent("synthetic"),
      adapter_version: "1",
      pricing_hash: hashContent(JSON.stringify(context.pricing)),
      ingested_at: "2026-01-01T00:00:00.000Z",
    });
    expect(await ingestSource(db, "synthetic", context, parse)).toBe("skipped");
    expect(calls).toBe(1);
    expect(await stored()).toEqual(before);
    await persistBatch(
      db,
      batch(),
      hashContent("synthetic"),
      hashContent(JSON.stringify(context.pricing)),
    );
    expect(await stored()).toEqual(before);
    expect(await ingestSource(db, "synthetic", { ...context, adapterVersion: "2" }, parse)).toBe(
      "persisted",
    );
    expect(calls).toBe(2);
    expect((await getCheckpoint(db, createSource(context).id))?.adapter_version).toBe("2");
  });

  it("persists a parent session link and a compaction turn, and rejects a non-boolean marker", async () => {
    const linked = batch();
    const parent = recordId(sourceFileId("opencode", "/synthetic/parent"), "session", "p");
    fixtureRow(linked.sessions).parent_session_id = parent;
    fixtureRow(linked.turns).is_compaction = true;
    expect(await ingestSource(db, "linked", context, () => linked)).toBe("persisted");
    const [, sessions, turns] = await stored();
    expect(sessions?.[0]).toMatchObject({ parent_session_id: parent });
    expect(turns?.[0]).toMatchObject({ is_compaction: true });
    const before = await stored();
    const invalid = batch();
    Object.assign(fixtureRow(invalid.turns), { is_compaction: "yes" });
    await expect(persistBatch(db, invalid, hashContent("other"))).rejects.toThrow();
    expect(await stored()).toEqual(before);
  });

  it("reprices unchanged content once per canonical pricing change and upgrades legacy checkpoints", async () => {
    const changed: ParseContext = {
      ...context,
      pricing: {
        version: 1,
        currency: "USD",
        basis: "current-reference",
        observedAt: "2026-10-21",
        entries: [
          {
            model: "synthetic",
            provider: "synthetic",
            validFrom: "2026-10-21",
            validTo: null,
            inputPerMTok: 2,
            outputPerMTok: 3,
            cacheReadPerMTok: 4,
            cacheWritePerMTok: 5,
          },
        ],
      },
    };
    let calls = 0;
    const parse = (_text: string, ctx: ParseContext) => {
      calls++;
      const snapshot = batch(ctx);
      const metrics = fixtureRow(snapshot.usage);
      metrics.computed_cost_usd = calculateCost(
        metrics,
        "synthetic",
        "synthetic",
        ctx.ingestedAt,
        ctx.pricing,
      );
      return snapshot;
    };
    await persistBatch(db, batch(), hashContent("same"));
    expect((await getCheckpoint(db, createSource(context).id))?.pricing_hash).toBeNull();
    expect(await ingestSource(db, "same", context, parse)).toBe("persisted");
    expect(await ingestSource(db, "same", context, parse)).toBe("skipped");
    const before = await db.all("SELECT * FROM usage");
    expect(await ingestSource(db, "same", changed, parse)).toBe("persisted");
    expect(await db.all("SELECT * FROM usage")).toEqual(
      before.map((row) => ({ ...row, computed_cost_usd: 0.000112 })),
    );
    const checkpoint = await getCheckpoint(db, createSource(context).id);
    expect(checkpoint).toMatchObject({
      content_hash: hashContent("same"),
      adapter_version: "1",
      pricing_hash: hashContent(JSON.stringify(changed.pricing)),
    });
    const snapshot = await stored();
    const reordered = {
      entries: changed.pricing.entries,
      observedAt: changed.pricing.observedAt,
      basis: changed.pricing.basis,
      currency: changed.pricing.currency,
      version: changed.pricing.version,
    };
    expect(await ingestSource(db, "same", { ...changed, pricing: reordered }, parse)).toBe(
      "skipped",
    );
    expect(calls).toBe(2);
    expect(await stored()).toEqual(snapshot);
    const failure = new Error("repricing failure");
    const failing: Database = {
      ...db,
      async run(sql, params) {
        if (sql.startsWith("INSERT INTO ingest_checkpoints")) throw failure;
        return db.run(sql, params);
      },
    };
    await expect(ingestSource(failing, "same", context, parse)).rejects.toBe(failure);
    expect(await stored()).toEqual(snapshot);
    expect(await getCheckpoint(db, createSource(context).id)).toEqual(checkpoint);
    expect(await ingestSource(db, "same", changed, parse)).toBe("skipped");
  });

  it("rejects an invalid pricing hash before mutation for backward-compatible direct callers", async () => {
    await persistBatch(db, batch(), hashContent("old"));
    const before = await stored();
    await expect(persistBatch(db, batch(), hashContent("new"), "invalid")).rejects.toThrow(
      "Invalid pricing hash",
    );
    expect(await stored()).toEqual(before);
  });

  it("replaces changed and truncated snapshots without touching another file or agent", async () => {
    const first = batch();
    const other = batch({ ...context, path: "/synthetic/other.jsonl" });
    const agent = batch({ ...context, agent: "claude-code" });
    for (const value of [first, other, agent]) await persistBatch(db, value, hashContent("a"));
    const unaffected = await stored();
    first.usage[0] = { ...fixtureRow(first.usage), input_tokens: 99 };
    const next = recordId(first.source.id, "turn", "second-turn");
    first.turns.push({ ...fixtureRow(first.turns), id: next, idx: 1 });
    first.usage.push({ ...first.usage[0], turn_id: next });
    first.issues = [];
    first.toolCalls = [];
    expect(await ingestSource(db, "append", context, () => first)).toBe("persisted");
    expect((await stored()).map((rows) => rows.length)).toEqual([3, 3, 4, 4, 2, 2, 3]);
    expect(
      (
        await db.all("SELECT input_tokens FROM usage WHERE turn_id = $1", [
          fixtureRow(first.turns).id,
        ])
      )[0],
    ).toMatchObject({ input_tokens: 99n });
    const empty = { ...first, sessions: [], turns: [], usage: [], toolCalls: [], issues: [] };
    expect(await ingestSource(db, "", context, () => empty)).toBe("persisted");
    const remaining = await stored();
    expect(remaining.map((rows) => rows.length)).toEqual([3, 2, 2, 2, 2, 2, 3]);
    const isOther = (row: Record<string, unknown>) =>
      Object.values(row).some(
        (value) =>
          typeof value === "string" &&
          (value.startsWith(other.source.id) || value.startsWith(agent.source.id)),
      );
    for (const [index, rows] of remaining.entries()) {
      expect(rows.filter(isOther)).toEqual(unaffected[index]?.filter(isOther));
    }
  });

  it("rejects invalid, private, orphaned, duplicate and cross-source rows before any mutation", async () => {
    await persistBatch(db, batch(), hashContent("old"));
    const before = await stored();
    const mutations = [
      (b: NormalizedBatch) => {
        fixtureRow(b.usage).input_tokens = -1;
      },
      (b: NormalizedBatch) => {
        Object.assign(fixtureRow(b.sessions), { title: "private text" });
      },
      (b: NormalizedBatch) => {
        Object.assign(fixtureRow(b.turns), { content: "private text" });
      },
      (b: NormalizedBatch) => {
        fixtureRow(b.usage).turn_id = "orphan";
      },
      (b: NormalizedBatch) => {
        b.sessions.push(fixtureRow(b.sessions));
      },
      (b: NormalizedBatch) => {
        fixtureRow(b.sessions).id = recordId(sourceFileId("pi", "/other"), "session", "x");
      },
      (b: NormalizedBatch) => {
        fixtureRow(b.issues).message = "raw parse error with secrets";
      },
    ];
    for (const mutate of mutations) {
      const invalid = batch();
      mutate(invalid);
      await expect(persistBatch(db, invalid, hashContent("new"))).rejects.toThrow();
      expect(await stored()).toEqual(before);
    }
    await expect(persistBatch(db, batch(), "invalid hash")).rejects.toThrow("Invalid content hash");
    await expect(
      ingestSource(db, "new", context, () => batch({ ...context, agent: "other" })),
    ).rejects.toThrow("Parser returned a different source");
    expect(await stored()).toEqual(before);
  });

  it("rolls back a database failure and preserves the original exception even if rollback fails", async () => {
    await persistBatch(db, batch(), hashContent("old"));
    const before = await stored();
    const original = new Error("synthetic database failure");
    let failRollback = false;
    const failing: Database = {
      ...db,
      async run(sql, params) {
        if (sql.startsWith("INSERT INTO usage")) throw original;
        if (failRollback && sql === "ROLLBACK") {
          await db.run(sql);
          throw new Error("rollback failed");
        }
        return db.run(sql, params);
      },
    };
    for (failRollback of [false, true]) {
      await expect(persistBatch(failing, batch(), hashContent("new"))).rejects.toBe(original);
      expect(await stored()).toEqual(before);
    }
  });

  it("persists child-owned subagent runs that survive a parent re-ingest and rejects unlinked runs", async () => {
    const parentContext = { ...context, path: "/synthetic/parent.jsonl" };
    const parent = fixtureRow(batch(parentContext).sessions).id;
    const child = batch({ ...context, path: "/synthetic/child.jsonl" });
    const session = fixtureRow(child.sessions);
    session.parent_session_id = parent;
    const run = {
      id: session.id,
      parent_session_id: parent,
      role: "gentle-ai-worker",
      model: "synthetic",
      provider: "synthetic",
      effort: "high",
      started_at: "2026-01-01T00:00:00.000Z",
      duration_ms: 1000,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
      reported_cost_usd: 0,
      computed_cost_usd: null,
    };
    await persistBatch(db, batch(parentContext), hashContent("parent"));
    await persistBatch(db, { ...child, subagentRuns: [run] }, hashContent("child"));
    const runs = () =>
      db.all("SELECT id, parent_session_id, role, input_tokens FROM subagent_runs");
    const expected = [
      { id: session.id, parent_session_id: parent, role: run.role, input_tokens: 10n },
    ];
    expect(await runs()).toEqual(expected);
    await persistBatch(db, batch(parentContext), hashContent("parent-changed"));
    expect(await runs()).toEqual(expected);
    await persistBatch(db, { ...child, subagentRuns: [run] }, hashContent("child-changed"));
    expect(await runs()).toEqual(expected);
    const before = await stored();
    for (const invalid of [
      { ...run, parent_session_id: "other" },
      { ...run, id: "missing" },
      { ...run, prompt: "PRIVATE_SENTINEL" },
    ]) {
      await expect(
        persistBatch(db, { ...child, subagentRuns: [invalid] }, hashContent("bad")),
      ).rejects.toThrow();
    }
    expect(await runs()).toEqual(expected);
    expect(await stored()).toEqual(before);
    await persistBatch(db, child, hashContent("child-unlinked"));
    expect(await runs()).toEqual([]);
  });
});
