import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
      ingested_at: "2026-01-01T00:00:00.000Z",
    });
    expect(await ingestSource(db, "synthetic", context, parse)).toBe("skipped");
    expect(calls).toBe(1);
    expect(await stored()).toEqual(before);
    await persistBatch(db, batch(), hashContent("synthetic"));
    expect(await stored()).toEqual(before);
    expect(await ingestSource(db, "synthetic", { ...context, adapterVersion: "2" }, parse)).toBe(
      "persisted",
    );
    expect(calls).toBe(2);
    expect((await getCheckpoint(db, createSource(context).id))?.adapter_version).toBe("2");
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
});
