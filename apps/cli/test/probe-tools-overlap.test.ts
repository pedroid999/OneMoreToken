import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { ToolsReport } from "../src/tools/contract";

/**
 * Independent verifier probes (spec §7.3, S3/S5): the tool rows overlap and must never be added up,
 * `sharedTurns` counts the turns where the tool was one of two or more, and a canonical tool used by
 * an agent without error status is unknown, not zero.
 */
let db: Database;
const from = "2026-01-01T00:00:00.000Z";
const to = "2026-01-03T00:00:00.000Z";

async function session(id: string, agent: string) {
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at, title,
      format_version, parent_session_id)
     VALUES ($1, 'src', $2, NULL, NULL, NULL, $3, NULL, NULL, 'test', NULL)`,
    [id, agent, from],
  );
}
type Usage = [number, number, number, number, number | null, number | null];
async function turn(
  id: string,
  sessionId: string,
  usage: Usage | undefined,
  tools: [string, "ok" | "error", number | null][],
) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id,
      is_compaction)
     VALUES ($1, $2, 0, $3, $4, $5, $6, NULL, NULL, false)`,
    [
      id,
      sessionId,
      usage ? "assistant" : "user",
      "2026-01-02T10:00:00Z",
      usage ? "m" : null,
      usage ? "p" : null,
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

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  const hash = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));
  await db.run(
    `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at,
      pricing_hash) VALUES ('src', 'h', 'test', $1, $2)`,
    [from, hash],
  );
  await session("s1", "claude-code");
  await session("s2", "codex");
  // One turn using three canonical tools (Read/read collapse into one) and one using a single tool.
  await turn(
    "t1",
    "s1",
    [100, 20, 30, 40, 1, 1],
    [
      ["Read", "ok", 10],
      ["read", "error", 30],
      ["Edit", "ok", null],
    ],
  );
  await turn("t2", "s1", [50, 5, 0, 0, null, 0.5], [["grep", "ok", 20]]);
  // Codex: `exec` is canonical `bash`, and Codex records no tool error status.
  await turn("t3", "s2", [7, 3, 0, 0, null, null], [["exec", "ok", 5]]);
  // A turn without tool calls, and one outside the period.
  await turn("t4", "s1", [1, 1, 1, 1, null, null], []);
});
afterEach(() => {
  db.close();
});

const report = async (): Promise<ToolsReport> => {
  const response = await createApp(db).request(`/api/tools?from=${from}&to=${to}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ToolsReport;
};

describe("verifier probes: overlapping tool rows (S3)", () => {
  it("row token sums exceed the tokens of the turns that used any tool: never a partition", async () => {
    const tools = await report();
    const rowsTotal = tools.tools.reduce((sum, row) => sum + row.tokens.total, 0);
    // t1 tokens = 190, counted in `read` and `edit`; t2 = 55 in `grep`; t3 = 10 in `bash`.
    expect(rowsTotal).toBe(190 + 190 + 55 + 10);
    expect(rowsTotal).toBeGreaterThan(190 + 55 + 10);
  });

  it("counts a turn once per distinct canonical tool and flags the shared ones", async () => {
    const tools = await report();
    const by = new Map(tools.tools.map((row) => [row.tool, row]));
    expect(by.get("read")).toMatchObject({ calls: 2, errors: 1, turns: 1, sharedTurns: 1 });
    expect(by.get("edit")).toMatchObject({ turns: 1, sharedTurns: 1, durationAvgKnownMs: null });
    expect(by.get("grep")).toMatchObject({ turns: 1, sharedTurns: 0 });
    expect(by.get("bash")).toMatchObject({ turns: 1, sharedTurns: 0, errorStatusKnown: false });
  });
});
