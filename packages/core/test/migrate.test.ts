import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
];

async function tableNames(db: Awaited<ReturnType<typeof openDatabase>>): Promise<string[]> {
  const rows = await db.all<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
  );
  return rows.map((r) => r.table_name);
}

describe("migrate", () => {
  it("creates every spec §4 table plus the migration ledger", async () => {
    const db = await openDatabase(":memory:");
    const result = await migrate(db);

    expect(result.applied.map((m) => m.version)).toEqual([1]);
    expect(await tableNames(db)).toEqual([...SPEC_TABLES, "schema_migrations"].sort());
    db.close();
  });

  it("is idempotent: a second run applies nothing and keeps the ledger unchanged", async () => {
    const db = await openDatabase(":memory:");
    await migrate(db);
    const second = await migrate(db);

    expect(second.applied).toEqual([]);
    const ledger = await db.all<{ version: number }>("SELECT version FROM schema_migrations");
    expect(ledger.map((r) => Number(r.version))).toEqual([1]);
    db.close();
  });

  it("persists to a file database across reopen", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "omt-")), "omt.duckdb");
    const first = await openDatabase(path);
    await migrate(first);
    first.close();

    const reopened = await openDatabase(path);
    expect((await migrate(reopened)).applied).toEqual([]);
    expect(await tableNames(reopened)).toContain("sessions");
    reopened.close();
  });

  it("rolls back a failing migration and records nothing for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-mig-"));
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
    const dir = mkdtempSync(join(tmpdir(), "omt-mig-"));
    writeFileSync(join(dir, "initial.sql"), "SELECT 1;");
    expect(() => listMigrations(dir)).toThrow(/initial\.sql/);
  });

  it("rejects duplicated migration numbers", () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-mig-"));
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
