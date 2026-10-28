import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database";
import { listMigrations, migrate } from "../src/db/migrate";
import { TABLE_SCHEMAS } from "../src/schema/tables";

const SPEC_TABLES = [
  "sources",
  "sessions",
  "turns",
  "usage",
  "tool_calls",
  "subagent_runs",
  "profiles",
  "turn_profile",
  "pricing",
  "subscriptions",
  "quota_windows",
  "calibrations",
  "commits",
  "ingest_issues",
  "subscription_rules",
];

const scratch: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function tableNames(db: Awaited<ReturnType<typeof openDatabase>>): Promise<string[]> {
  const rows = await db.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("migrate", () => {
  it("creates every spec §4 table plus the migration and checkpoint ledgers", async () => {
    const db = await openDatabase(":memory:");
    const result = await migrate(db);

    expect(result.applied.map((m) => m.version)).toEqual([1, 2, 3, 4, 5]);
    expect(await tableNames(db)).toEqual(
      [...SPEC_TABLES, "schema_migrations", "ingest_checkpoints"].sort(),
    );
    db.close();
  });

  it("is idempotent: a second run applies nothing and keeps the ledger unchanged", async () => {
    const db = await openDatabase(":memory:");
    await migrate(db);
    const second = await migrate(db);

    expect(second.applied).toEqual([]);
    const ledger = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(ledger.map((r) => Number(r.version))).toEqual([1, 2, 3, 4, 5]);
    db.close();
  });

  it("upgrades version 1 without changing its existing rows or tables", async () => {
    const dir = temp("omt-upgrade-");
    const initial = listMigrations()[0];
    if (!initial) throw new Error("Expected the initial migration");
    writeFileSync(join(dir, initial.name), readFileSync(initial.path, "utf8"));
    const db = await openDatabase(":memory:");
    await migrate(db, dir);
    expect(await tableNames(db)).toEqual(
      [...SPEC_TABLES.filter((t) => t !== "subscription_rules"), "schema_migrations"].sort(),
    );
    await db.run("INSERT INTO sources VALUES ('old', 'pi', '/synthetic/old', '1', NULL)");
    const before = await db.all("SELECT * FROM sources");
    expect((await migrate(db)).applied.map((m) => m.version)).toEqual([2, 3, 4, 5]);
    expect(await db.all("SELECT * FROM sources")).toEqual(before);
    expect(await db.all("SELECT * FROM ingest_checkpoints")).toEqual([]);
    db.close();
  });

  it("upgrades version 2 preserving checkpoint and usage values with a null pricing hash", async () => {
    const dir = temp("omt-pricing-upgrade-");
    for (const migration of listMigrations().filter((entry) => entry.version <= 2)) {
      writeFileSync(join(dir, migration.name), readFileSync(migration.path, "utf8"));
    }
    const db = await openDatabase(":memory:");
    await migrate(db, dir);
    await db.run("INSERT INTO ingest_checkpoints VALUES ('old', 'hash', 'v1', '2026-01-01')");
    await db.run("INSERT INTO usage VALUES ('turn', 1, 2, 3, 4, 0, 5)");
    const usage = await db.all("SELECT * FROM usage");
    const checkpoints = await db.all("SELECT * FROM ingest_checkpoints");
    expect((await migrate(db)).applied.map((entry) => entry.version)).toEqual([3, 4, 5]);
    expect(await db.all("SELECT * FROM usage")).toEqual(usage);
    expect(await db.all("SELECT * FROM ingest_checkpoints")).toEqual(
      checkpoints.map((row) => ({ ...row, pricing_hash: null })),
    );
    db.close();
  });

  it("upgrades version 3 keeping sessions and turns with no parent and no compaction", async () => {
    const dir = temp("omt-session-upgrade-");
    for (const migration of listMigrations().filter((entry) => entry.version <= 3)) {
      writeFileSync(join(dir, migration.name), readFileSync(migration.path, "utf8"));
    }
    const db = await openDatabase(":memory:");
    await migrate(db, dir);
    await db.run(
      "INSERT INTO sessions VALUES ('s', 'src', 'pi', NULL, NULL, NULL, '2026-01-01T00:00:00Z', NULL, NULL, '3')",
    );
    await db.run(
      "INSERT INTO turns VALUES ('t', 's', 0, 'assistant', '2026-01-01T00:00:00Z', 'm', 'p', NULL, NULL)",
    );
    const sessions = await db.all("SELECT * FROM sessions");
    const turns = await db.all("SELECT * FROM turns");
    expect((await migrate(db)).applied.map((entry) => entry.version)).toEqual([4, 5]);
    expect(await db.all("SELECT * FROM sessions")).toEqual(
      sessions.map((row) => ({ ...row, parent_session_id: null })),
    );
    expect(await db.all("SELECT * FROM turns")).toEqual(
      turns.map((row) => ({ ...row, is_compaction: false })),
    );
    db.close();
  });

  it("adds the subscription rules table and the turn_subscriptions view", async () => {
    const db = await openDatabase(":memory:");
    await migrate(db);
    const views = await db.all<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'VIEW'",
    );
    expect(views.map((v) => v.table_name)).toEqual(["turn_subscriptions"]);
    expect(await db.all("SELECT * FROM turn_subscriptions")).toEqual([]);
    db.close();
  });

  it("persists to a file database across reopen", async () => {
    const path = join(temp("omt-"), "omt.duckdb");
    const first = await openDatabase(path);
    await migrate(first);
    first.close();

    const reopened = await openDatabase(path);
    expect((await migrate(reopened)).applied).toEqual([]);
    expect(await tableNames(reopened)).toContain("sessions");
    reopened.close();
  });

  it("rolls back a failing migration and records nothing for it", async () => {
    const dir = temp("omt-mig-");
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE ok_table (id INTEGER);");
    writeFileSync(join(dir, "002_broken.sql"), "CREATE TABLE half (id INTEGER); THIS IS NOT SQL;");
    const db = await openDatabase(":memory:");

    await expect(migrate(db, dir)).rejects.toThrow(/002_broken\.sql/);
    const ledger = await db.all<{ version: number }>("SELECT version FROM schema_migrations");
    expect(ledger.map((r) => Number(r.version))).toEqual([1]);
    expect(await tableNames(db)).not.toContain("half");
    db.close();
  });

  it("rejects migration files without a numbered prefix", () => {
    const dir = temp("omt-mig-");
    writeFileSync(join(dir, "initial.sql"), "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/initial\.sql/);
  });

  it("rejects duplicated migration numbers", () => {
    const dir = temp("omt-mig-");
    writeFileSync(join(dir, "001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "001_b.sql"), "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/duplicate migration version 1/i);
  });
});

describe("table schemas", () => {
  it("define a Zod schema for every spec §4 table", () => {
    expect(Object.keys(TABLE_SCHEMAS).sort()).toEqual([...SPEC_TABLES].sort());
  });

  it.each(SPEC_TABLES)("Zod keys of %s match the SQL columns", async (table) => {
    const db = await openDatabase(":memory:");
    await migrate(db);
    const columns = await db.all<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name",
      [table],
    );
    const schema = TABLE_SCHEMAS[table as keyof typeof TABLE_SCHEMAS];
    expect(Object.keys(schema.shape).sort()).toEqual(columns.map((c) => c.column_name).sort());
    db.close();
  });
});

describe("migrate error reporting", () => {
  it("keeps the original migration error when ROLLBACK fails too", async () => {
    const dir = temp("omt-mig-");
    writeFileSync(join(dir, "001_broken.sql"), "BROKEN;");
    const original = new Error("syntax error at BROKEN");
    const fake = {
      async run(sql: string) {
        if (sql === "BROKEN;") throw original;
        if (sql === "ROLLBACK") throw new Error("no transaction is active");
      },
      async all() {
        return [];
      },
      close() {},
    };

    const failure = await migrate(fake, dir).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toBe(
      "Migration 001_broken.sql failed: syntax error at BROKEN (rollback also failed: no transaction is active)",
    );
    expect(failure?.cause).toBe(original);
  });
});
