import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, migrate, openDatabase, type SavedQuery } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

let db: Database;
let home: string;
let directory: string;
let app: ReturnType<typeof createApp>;

const JSON_HEADERS = { "content-type": "application/json" };

interface SqlResponse {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

interface SavedQueryList {
  views: SavedQuery[];
  invalid: { id: string }[];
}

/** Hono hands back `unknown`; the assertions below pin the shapes that matter. */
const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  await db.run("CREATE TABLE sql_probe(a INTEGER)");
  await db.run("INSERT INTO sql_probe VALUES (1)");
  home = mkdtempSync(join(tmpdir(), "omt-sql-"));
  directory = join(home, "data", "one-more-token", "sql-views");
  app = createApp(db, { sql: { directory, timeoutMs: 2000 } });
});
afterEach(() => {
  db.close();
});

function query(sql: unknown, init: RequestInit = {}) {
  return app.request("/api/sql/query", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ sql }),
    ...init,
  });
}

const probeRows = async () =>
  (await db.all<{ count: bigint }>("SELECT count(*) AS count FROM sql_probe")).map((row) =>
    Number(row.count),
  );

function save(id: string, body: unknown) {
  return app.request(`/api/sql/views/${id}`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

describe("SQL console queries (spec §7.1, T4)", () => {
  it("returns typed columns and JSON-safe rows for a read-only query", async () => {
    const response = await query("SELECT 1 AS one, 'x' AS text, now() IS NOT NULL AS flag");
    expect(response.status).toBe(200);
    const body = await bodyOf<SqlResponse>(response);
    expect(body.columns).toEqual([
      { name: "one", type: "INTEGER" },
      { name: "text", type: "VARCHAR" },
      { name: "flag", type: "BOOLEAN" },
    ]);
    expect(body.rows).toEqual([[1, "x", true]]);
    expect(body.rowCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("rejects every write statement without changing data or schema", async () => {
    for (const sql of [
      "INSERT INTO sql_probe VALUES (2)",
      "UPDATE sql_probe SET a = 2",
      "DELETE FROM sql_probe",
      "DROP TABLE sql_probe",
      "CREATE TABLE made_by_console(a INTEGER)",
      "ALTER TABLE sql_probe ADD COLUMN b INTEGER",
      "ATTACH ':memory:' AS other",
      "COPY sql_probe TO '/tmp/omt-sql-copy.csv'",
    ]) {
      const response = await query(sql);
      expect(response.status, sql).toBe(400);
      expect((await bodyOf<{ error: string }>(response)).error).toBe("query failed");
    }
    expect(await probeRows()).toEqual([1]);
    const tables = await db.all<{ name: string }>(
      "SELECT table_name AS name FROM information_schema.tables",
    );
    expect(tables.map((table) => table.name)).not.toContain("made_by_console");
    expect(tables.map((table) => table.name)).toContain("sql_probe");
  });

  it("rejects multiple statements of any kind", async () => {
    for (const sql of ["SELECT 1; DROP TABLE sql_probe", "SELECT 1; SELECT 2", "  ;  "]) {
      const response = await query(sql);
      expect(response.status, sql).toBe(400);
    }
    expect(await probeRows()).toEqual([1]);
  });

  it("accepts a semicolon inside a string literal", async () => {
    for (const sql of ["SELECT ';' AS s", "SELECT 'a;b' AS s"]) {
      const response = await query(sql);
      expect(response.status, sql).toBe(200);
      expect((await bodyOf<SqlResponse>(response)).rows).toEqual([
        [sql.includes("a;b") ? "a;b" : ";"],
      ]);
    }
  });

  it("caps the rows it returns and reports the truncation", async () => {
    const capped = await query("SELECT i::INTEGER AS i FROM range(0, 1500) AS t(i)");
    expect(capped.status).toBe(200);
    const body = await bodyOf<SqlResponse>(capped);
    expect(body.rows).toHaveLength(1000);
    expect(body.rowCount).toBe(1000);
    expect(body.truncated).toBe(true);
    expect(body.rows[0]).toEqual([0]);

    const short = await bodyOf<SqlResponse>(
      await query("SELECT i::INTEGER AS i FROM range(0, 5) AS t(i)"),
    );
    expect(short.rows).toHaveLength(5);
    expect(short.rowCount).toBe(5);
    expect(short.truncated).toBe(false);

    const exact = await bodyOf<SqlResponse>(
      await query("SELECT i::INTEGER AS i FROM range(0, 1000) AS t(i)"),
    );
    expect(exact.rowCount).toBe(1000);
    expect(exact.truncated).toBe(false);
    const above = await bodyOf<SqlResponse>(
      await query("SELECT i::INTEGER AS i FROM range(0, 1001) AS t(i)"),
    );
    expect(above.rowCount).toBe(1000);
    expect(above.truncated).toBe(true);
  });

  it("interrupts a runaway query and keeps the connection usable", async () => {
    const slow = createApp(db, { sql: { directory, timeoutMs: 1 } });
    const response = await slow.request("/api/sql/query", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sql: "SELECT sum(i) FROM range(0, 2000000000) AS t(i)" }),
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: "query timed out" });
    const after = await query("SELECT 42 AS answer");
    expect(after.status).toBe(200);
    expect((await bodyOf<SqlResponse>(after)).rows).toEqual([[42]]);
  });

  it("rejects invalid, oversized and malformed requests with fixed diagnostics", async () => {
    for (const body of [{}, { sql: "" }, { sql: "   " }, { sql: 7 }, { sql: "x".repeat(20001) }]) {
      const response = await app.request("/api/sql/query", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid sql" });
    }
    const malformed = await app.request("/api/sql/query", {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid sql" });
    const oversized = await app.request("/api/sql/query", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ sql: "SELECT 1", pad: "x".repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(400);
  });

  it("needs a loopback origin and a JSON content type", async () => {
    const hostile = await query("SELECT 1", {
      headers: { ...JSON_HEADERS, origin: "https://evil" },
    });
    expect(hostile.status).toBe(403);
    const plain = await app.request("/api/sql/query", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "SELECT 1",
    });
    expect(plain.status).toBe(415);
  });
});

describe("saved SQL queries (spec §7.1, T4)", () => {
  it("saves, lists and deletes a query in a private file", async () => {
    const created = await save("daily-tokens", { name: "Daily tokens", sql: "SELECT 1" });
    expect(created.status).toBe(200);
    const saved = await bodyOf<SavedQuery>(created);
    expect(saved).toMatchObject({
      schema: "omt.saved-query/1",
      id: "daily-tokens",
      name: "Daily tokens",
      sql: "SELECT 1",
    });
    expect(Number.isNaN(Date.parse(saved.updatedAt))).toBe(false);

    const file = join(directory, "daily-tokens.json");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(saved);

    const listed = await app.request("/api/sql/views");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ views: [saved], invalid: [] });

    expect((await app.request("/api/sql/views/daily-tokens", { method: "DELETE" })).status).toBe(
      204,
    );
    expect(await (await app.request("/api/sql/views")).json()).toEqual({ views: [], invalid: [] });
    const again = await app.request("/api/sql/views/daily-tokens", { method: "DELETE" });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: "saved query not found" });
  });

  it("overwrites a query with the same id and lists corrupt files as invalid", async () => {
    await save("mine", { name: "Mine", sql: "SELECT 1" });
    const overwritten = await save("mine", { name: "Mine again", sql: "SELECT 2" });
    expect((await bodyOf<SavedQuery>(overwritten)).name).toBe("Mine again");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "broken.json"), "{not json");
    writeFileSync(
      join(directory, "misnamed.json"),
      JSON.stringify({ schema: "omt.saved-query/1", id: "other", name: "x", sql: "SELECT 1" }),
    );
    const listed = await bodyOf<SavedQueryList>(await app.request("/api/sql/views"));
    expect(listed.invalid).toEqual([{ id: "broken" }, { id: "misnamed" }]);
    expect(listed.views).toHaveLength(1);
  });

  it("refuses invalid ids, invalid bodies and hostile requests", async () => {
    for (const id of ["Bad Id", "under_score", "a".repeat(65)]) {
      const response = await save(id, { name: "x", sql: "SELECT 1" });
      expect(response.status, id).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid saved query" });
    }
    for (const body of [{}, { name: "", sql: "SELECT 1" }, { name: "x", sql: "" }, { name: "x" }]) {
      const response = await save("mine", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid saved query" });
    }
    const tooLong = await save("mine", { name: "x", sql: `SELECT '${"x".repeat(20000)}'` });
    expect(tooLong.status).toBe(400);
    const plain = await app.request("/api/sql/views/mine", {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "SELECT 1",
    });
    expect(plain.status).toBe(415);
  });

  it("never follows a symlinked storage directory or file", async () => {
    const real = join(home, "elsewhere");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(home, "data", "one-more-token"), { recursive: true });
    symlinkSync(real, directory);
    const refused = await save("mine", { name: "x", sql: "SELECT 1" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "unsafe sql view storage" });
    expect((await app.request("/api/sql/views")).status).toBe(409);
    expect(readdirSync(real)).toEqual([]);
  });

  it("never writes through a symlinked target file", async () => {
    mkdirSync(directory, { recursive: true });
    const outside = join(home, "outside.json");
    writeFileSync(outside, "{}");
    symlinkSync(outside, join(directory, "mine.json"));
    const response = await save("mine", { name: "x", sql: "SELECT 1" });
    expect(response.status).toBe(409);
    expect(readFileSync(outside, "utf8")).toBe("{}");
    const listed = await bodyOf<SavedQueryList>(await app.request("/api/sql/views"));
    expect(listed.invalid).toEqual([{ id: "mine" }]);
  });
});
