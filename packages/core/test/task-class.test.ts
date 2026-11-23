import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db/database";
import { openDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";
import {
  CORRECTABLE_TASK_CLASSES,
  derivedTaskClassSql,
  TASK_CLASS_SOURCES,
  TASK_CLASSES,
} from "../src/tasks/task-class";

let db: Database;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(() => {
  db.close();
});

async function session(id: string, agent = "pi") {
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, cwd, repo, branch, started_at, ended_at,
      title, format_version, parent_session_id)
     VALUES ($1, 'src', $2, NULL, NULL, NULL, '2026-01-01T00:00:00Z', NULL, NULL, 'test', NULL)`,
    [id, agent],
  );
}

async function turn(id: string, sessionId: string, idx = 0) {
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, subscription_id,
      is_compaction)
     VALUES ($1, $2, $3, 'assistant', '2026-01-01T00:00:00Z', NULL, NULL, NULL, NULL, false)`,
    [id, sessionId, idx],
  );
}

const derived = async () => {
  const rows = await db.all<{ id: string; task_class: string }>(
    `SELECT s.id, ${derivedTaskClassSql("s.id")} AS task_class FROM sessions s ORDER BY s.id`,
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.task_class]));
};

describe("derived task class (spec §7.3, phase 5 L3)", () => {
  it("exposes the closed vocabularies of the class and its source", () => {
    expect(TASK_CLASSES).toEqual(["feature", "inline", "unknown"]);
    expect(CORRECTABLE_TASK_CLASSES).toEqual(["feature", "inline"]);
    expect(TASK_CLASS_SOURCES).toEqual(["derived", "corrected"]);
  });

  it("derives feature from a commit attributed to one of the session's turns", async () => {
    await session("s1");
    await turn("t1", "s1");
    await db.run("INSERT INTO turn_commits VALUES ('t1', '/synthetic/repo', 'abc1234')");

    expect(await derived()).toEqual({ s1: "feature" });
  });

  it("derives feature from a subagent run whose parent is the session", async () => {
    await session("s1");
    await db.run(
      `INSERT INTO subagent_runs (id, parent_session_id, role) VALUES ('r1', 's1', 'build')`,
    );
    await session("s2");
    await db.run(
      `INSERT INTO subagent_runs (id, parent_session_id, role) VALUES ('r2', 's2', 'build')`,
    );
    await db.run("INSERT INTO session_repos VALUES ('s2', '/synthetic/repo')");

    expect(await derived()).toEqual({ s1: "feature", s2: "feature" });
  });

  it("derives inline only with a resolved repository and no positive evidence", async () => {
    await session("s1");
    await db.run("INSERT INTO session_repos VALUES ('s1', '/synthetic/repo')");

    expect(await derived()).toEqual({ s1: "inline" });
  });

  it("derives unknown without a repository or positive evidence", async () => {
    await session("s1");
    await turn("t1", "s1");
    await session("s2");

    expect(await derived()).toEqual({ s1: "unknown", s2: "unknown" });
  });

  it("does not read another session's commits as evidence", async () => {
    await session("s1");
    await session("s2");
    await db.run("INSERT INTO session_repos VALUES ('s2', '/synthetic/repo')");
    await turn("t1", "s1");
    await db.run("INSERT INTO turn_commits VALUES ('t1', '/synthetic/repo', 'abc1234')");

    expect(await derived()).toEqual({ s1: "feature", s2: "inline" });
  });
});

describe("session_task_classes row schema", () => {
  it("keeps the correction limited to the correctable classes and never rewrites it by itself", async () => {
    await session("s1");
    await db.run(
      "INSERT INTO session_task_classes (session_id, task_class) VALUES ('s1', 'inline')",
    );
    const [row] = await db.all<{ task_class: string; updated_at: string }>(
      "SELECT task_class, updated_at FROM session_task_classes WHERE session_id = 's1'",
    );
    expect(row?.task_class).toBe("inline");
    expect(row?.updated_at).toBeTruthy();
    for (const invalid of ["unknown", "Feature", ""]) {
      await expect(
        db.run("INSERT INTO session_task_classes (session_id, task_class) VALUES ('s2', $1)", [
          invalid,
        ]),
      ).rejects.toThrow();
    }
  });
});
