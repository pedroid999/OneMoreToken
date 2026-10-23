import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/app";
import { withDatabase } from "../src/db-queue";

let db: Database;
beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(() => db.close());

it("serializes transactions, returns results and releases health/writes after rejection", async () => {
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = withDatabase(db, async () => {
    await db.run("BEGIN TRANSACTION");
    await db.run("INSERT INTO profiles VALUES ('a', 'synthetic', '{}', '2026-01-01')");
    started();
    await gate;
    await db.run("COMMIT");
    return 1;
  });
  await began;
  const failure = withDatabase(db, async () => {
    await db.run("BEGIN TRANSACTION");
    await db.run("INSERT INTO profiles VALUES ('b', 'synthetic', '{}', '2026-01-01')");
    await db.run("ROLLBACK");
    throw new Error("synthetic failure");
  });
  const rejected = expect(failure).rejects.toThrow("synthetic failure");
  const health = createApp(db, { ingest: { roots: [] } }).request("/api/health");
  const second = withDatabase(db, async () => {
    await db.run("BEGIN TRANSACTION");
    await db.run("INSERT INTO profiles VALUES ('c', 'synthetic', '{}', '2026-01-01')");
    await db.run("COMMIT");
    return 2;
  });
  release();
  expect(await first).toBe(1);
  await rejected;
  expect((await health).status).toBe(200);
  expect(await second).toBe(2);
  expect(await db.all("SELECT hash FROM profiles ORDER BY hash")).toEqual([
    { hash: "a" },
    { hash: "c" },
  ]);
});
