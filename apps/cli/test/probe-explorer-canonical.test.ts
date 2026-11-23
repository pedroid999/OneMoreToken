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
import type { ExplorerResponse } from "../src/explorer/contract";

/**
 * Independent verifier probes (spec §7.3, S4): the Explorer `tool` dimension groups canonically, a
 * turn counts once per distinct canonical tool, the null group survives, and `in`/`notIn` compare
 * canonical names (so a raw spelling such as `exec` matches nothing).
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
async function turn(
  id: string,
  sessionId: string,
  tools: string[],
  usage?: [number, number, number, number],
) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id,
      is_compaction) VALUES ($1, $2, 0, $3, $4, $5, $6, NULL, NULL, false)`,
    [
      id,
      sessionId,
      usage ? "assistant" : "user",
      "2026-01-02T10:00:00Z",
      usage ? "m" : null,
      usage ? "p" : null,
    ],
  );
  if (usage)
    await db.run("INSERT INTO usage VALUES ($1, $2, $3, $4, $5, NULL, NULL)", [id, ...usage]);
  for (const [i, tool] of tools.entries())
    await db.run("INSERT INTO tool_calls VALUES ($1, $2, $3, NULL, 'ok')", [
      `${id}-${i}`,
      id,
      tool,
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
  // `Read` and `read` in the same turn: one canonical tool for that turn.
  await turn("t1", "s1", ["Read", "read"], [10, 1, 0, 0]);
  await turn("t2", "s2", ["exec"]);
  await turn("t3", "s1", []);
});
afterEach(() => {
  db.close();
});

const query = async (body: unknown): Promise<ExplorerResponse> => {
  const response = await createApp(db).request("/api/explorer/query", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:7317" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ExplorerResponse;
};
const base = { metrics: ["turns"], filters: [], from, to } as const;

describe("verifier probes: canonical tool dimension (S4)", () => {
  it("merges Read/read, maps exec to bash and keeps the null group", async () => {
    const result = await query({ ...base, dimensions: ["tool"] });
    const rows = result.rows as { tool: string | null; turns: number }[];
    expect(rows.map((row) => row.tool)).toEqual(["bash", "read", null]);
    expect(rows.find((row) => row.tool === "read")?.turns).toBe(1);
    expect(rows.find((row) => row.tool === null)?.turns).toBe(1);
  });

  it("compares canonical names in in/notIn filters", async () => {
    const bash = await query({
      ...base,
      dimensions: ["tool"],
      filters: [{ dimension: "tool", op: "in", values: ["bash"] }],
    });
    expect(bash.rows).toEqual([{ tool: "bash", turns: 1 }]);
    const raw = await query({
      ...base,
      dimensions: ["tool"],
      filters: [{ dimension: "tool", op: "in", values: ["exec"] }],
    });
    expect(raw.rows).toEqual([]);
    const notBash = await query({
      ...base,
      dimensions: ["tool"],
      filters: [{ dimension: "tool", op: "notIn", values: ["bash"] }],
    });
    expect((notBash.rows as { tool: string | null }[]).map((row) => row.tool)).toEqual([
      "read",
      null,
    ]);
  });
});
