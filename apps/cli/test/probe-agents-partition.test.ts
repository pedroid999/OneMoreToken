import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentsReport } from "../src/agents/contract";
import { createApp } from "../src/app";

/**
 * Independent verifier probes (spec §7.3, S2): one row per (task class, source, agent), the rows
 * partition the sessions of the period, a correction is its own row, and `cacheHitRatio` is null
 * when there are no tokens, never 0.
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
async function turn(id: string, sessionId: string, usage?: [number, number, number, number]) {
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
}

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await session("s1", "claude-code");
  await session("s2", "gentle-shell");
  await session("s3", "opencode");
  await session("s4", "pi");
  await turn("t1", "s1", [100, 10, 90, 0]);
  await turn("t2", "s2"); // no usage at all
  await turn("t3", "s3", [10, 1, 0, 5]);
  await turn("t4", "s4", [5, 5, 5, 5]);
  await db.run("INSERT INTO session_repos (session_id, repo) VALUES ('s3', 'r')");
  await db.run(
    "INSERT INTO commits (repo, sha, authored_at, message) VALUES ('r', 'sha', $1, 'm')",
    [from],
  );
  await db.run("INSERT INTO turn_commits (turn_id, repo, sha) VALUES ('t4', 'r', 'sha')");
  await db.run(
    `INSERT INTO subagent_runs (id, parent_session_id, role, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens) VALUES ('sr', 's2', 'w', 1, 1, 1, 1)`,
  );
  await db.run(
    "INSERT INTO session_task_classes (session_id, task_class) VALUES ('s3', 'feature')",
  );
});
afterEach(() => {
  db.close();
});

const report = async (): Promise<AgentsReport> => {
  const response = await createApp(db).request(`/api/agents?from=${from}&to=${to}`);
  expect(response.status).toBe(200);
  return (await response.json()) as AgentsReport;
};

describe("verifier probes: agents rows (S2, S5)", () => {
  it("has one row per (class, source, agent) and the rows partition the period sessions", async () => {
    const agents = await report();
    const keys = agents.rows.map((row) => `${row.taskClass}|${row.source}|${row.agent}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(agents.rows.reduce((sum, row) => sum + row.sessions, 0)).toBe(4);
    expect(agents.rows.reduce((sum, row) => sum + row.turns, 0)).toBe(4);
  });

  it("derives the class from positive evidence and keeps the corrected row apart", async () => {
    const agents = await report();
    const find = (agent: string) => agents.rows.find((row) => row.agent === agent);
    expect(find("claude-code")).toMatchObject({ taskClass: "unknown", source: "derived" });
    expect(find("gentle-shell")).toMatchObject({ taskClass: "feature", source: "derived" });
    expect(find("opencode")).toMatchObject({ taskClass: "feature", source: "corrected" });
    expect(find("pi")).toMatchObject({ taskClass: "feature", source: "derived" });
    expect(agents.totals).toEqual({ derivedSessions: 3, correctedSessions: 1 });
  });

  it("reports cacheHitRatio as null without tokens, never 0", async () => {
    const agents = await report();
    const zero = agents.rows.find((row) => row.tokens.total === 0);
    expect(zero?.cacheHitRatio).toBeNull();
    expect(agents.rows.find((row) => row.tokens.total > 0)?.cacheHitRatio).not.toBeNull();
  });
});
