import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePi } from "@omt/adapters";
import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const now = "2026-01-10T00:00:00.000Z";
const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: now });
const assistant = (id: string) =>
  JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: now,
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "PRIVATE_SENTINEL" }],
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 },
    },
  });
const content = `${header}\n${assistant("a")}\n`;
let db: Database;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "omt-ingest-"));
  db = await openDatabase(":memory:");
  await migrate(db);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
function app(options: Parameters<typeof createApp>[1] = {}) {
  return createApp(db, {
    ingest: { roots: [{ agent: "pi", path: root }], now: () => now },
    ...options,
  });
}
function post(application = app(), body: unknown = {}, headers: Record<string, string> = {}) {
  return application.request("/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
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
const metrics = (files: number, persisted = files, skipped = 0, failed = 0, issues = 0) => ({
  files,
  persisted,
  skipped,
  failed,
  issues,
});

describe("POST /api/ingest", () => {
  it("persists metrics only, leaves source bytes/mtime unchanged and skips an identical snapshot", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(path, content);
    const before = await stat(path);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(metrics(1));
    const snapshot = await stored();
    expect(snapshot.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 0, 0, 1]);
    expect(snapshot[0]?.[0]).toMatchObject({ agent: "pi", adapter_version: "pi-v3/1" });
    expect(snapshot[3]?.[0]).toMatchObject({ input_tokens: 10n, output_tokens: 2n });
    expect(
      JSON.stringify(snapshot, (_key, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toContain("PRIVATE_SENTINEL");
    expect(await readFile(path, "utf8")).toBe(content);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(metrics(1, 0, 1));
    expect(await stored()).toEqual(snapshot);
  });

  it("reparses append/rewrite snapshots, counts a corrupt middle row and continues", async () => {
    const path = join(root, "session.jsonl");
    await writeFile(path, content);
    await post();
    await writeFile(path, `${content}PRIVATE_SENTINEL broken\n${assistant("b")}\n`);
    const appended = await post();
    expect(appended.status).toBe(200);
    expect(await appended.json()).toEqual(metrics(1, 1, 0, 0, 1));
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1, 2, 2, 0, 1, 1]);
    expect(await db.all("SELECT code, message FROM ingest_issues")).toEqual([
      { code: "invalid_json", message: "Invalid JSON record" },
    ]);
    await writeFile(path, `${header}\n`);
    expect(await (await post()).json()).toEqual(metrics(1));
    expect((await stored()).map((rows) => rows.length)).toEqual([1, 1, 0, 0, 0, 0, 1]);
  });

  it("selects by file mtime only, preserving previously persisted older snapshots", async () => {
    for (const name of ["old", "new"]) await writeFile(join(root, `${name}.jsonl`), content);
    await utimes(join(root, "old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
    await utimes(join(root, "new.jsonl"), new Date(now), new Date(now));
    expect(await (await post()).json()).toEqual(metrics(2));
    await writeFile(join(root, "old.jsonl"), "bad");
    await utimes(join(root, "old.jsonl"), new Date("2026-01-01"), new Date("2026-01-01"));
    expect(await (await post(app(), { since: now })).json()).toEqual(metrics(1, 0, 1));
    expect((await stored()).map((rows) => rows.length)).toEqual([2, 2, 2, 2, 0, 0, 2]);
  });

  it("recurses without following symlink files, directories, loops or linked-home ancestors", async () => {
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "a.jsonl"), content);
    await writeFile(join(root, "ignored.txt"), content);
    await symlink(root, join(root, "nested", "loop"));
    await symlink(join(root, "nested", "a.jsonl"), join(root, "duplicate.jsonl"));
    await symlink(join(root, "nested"), join(root, "linked"));
    const application = app({
      ingest: {
        roots: [
          { agent: "pi", path: root },
          { agent: "gentle-shell", path: join(root, "linked", "sessions") },
          { agent: "claude-code", path: join(root, "absent") },
        ],
      },
    });
    expect(await (await post(application)).json()).toEqual(metrics(1));
    expect((await db.all("SELECT * FROM sources")).length).toBe(1);
  });

  it("reports absent explicit roots and read/parser errors safely, continuing other files", async () => {
    const missing = await post(app(), { agent: "pi", path: join(root, "absent") });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual(metrics(0, 0, 0, 1, 1));
    for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.jsonl`), content);
    const application = app({
      ingest: {
        roots: [{ agent: "pi", path: root }],
        fs: {
          lstat,
          readdir: (path) => readdir(path, { withFileTypes: true }),
          readFile: async (path) => {
            if (path.endsWith("a.jsonl")) throw new Error("PRIVATE_SENTINEL path/credential");
            return readFile(path, "utf8");
          },
        },
        parsers: {
          pi: (text, ctx) => {
            if (ctx.path.endsWith("b.jsonl")) throw new Error("PRIVATE_SENTINEL parser");
            return parsePi(text, ctx);
          },
        },
      },
    });
    const response = await post(application);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(metrics(3, 1, 0, 2, 2));
    expect((await db.all("SELECT * FROM sources")).length).toBe(1);
  });

  it.each(["claude-code", "gentle-shell", "pi"] as const)(
    "uses the exported %s adapter",
    async (agent) => {
      const fixture = fileURLToPath(
        new URL(
          `../../../packages/adapters/${agent === "gentle-shell" ? "pi" : agent}/fixtures/session.jsonl`,
          import.meta.url,
        ),
      );
      await writeFile(join(root, "session.jsonl"), await readFile(fixture));
      const response = await post(app(), { agent, path: root });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        files: 1,
        persisted: 1,
        skipped: 0,
        failed: 0,
      });
      expect(await db.all("SELECT agent FROM sources")).toEqual([{ agent }]);
      expect((await db.all("SELECT * FROM usage")).length).toBe(2);
    },
  );

  it.each(
    [
      null,
      [],
      { agent: "other" },
      { agent: ["pi"] },
      { path: "/synthetic" },
      { agent: "pi", path: "relative" },
      { agent: "pi", path: "/bad\u0000path" },
      { since: "yesterday" },
      { since: "2026-02-30T00:00:00Z" },
      { since: 123 },
      { unknown: true },
    ].map((body) => [body]),
  )("rejects invalid input %j before filesystem/database access", async (body) => {
    const before = await stored();
    const access = vi.fn(() => {
      throw new Error("must not discover");
    });
    const application = app({
      ingest: { roots: [], fs: { lstat: access, readdir: access, readFile: access } },
    });
    const response = await post(application, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid ingest options" });
    expect(access).not.toHaveBeenCalled();
    expect(await stored()).toEqual(before);
  });

  it("rejects malformed/oversized JSON before ingestion and hides unexpected service errors", async () => {
    const application = app();
    const before = await stored();
    for (const body of ["{", JSON.stringify({ path: "x".repeat(17000) })]) {
      const response = await application.request("/api/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid ingest options" });
      expect(await stored()).toEqual(before);
    }
    const failed = await post(
      app({
        ingest: {
          roots: [],
          now: () => {
            throw new Error("PRIVATE_SENTINEL");
          },
        },
      }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "ingestion failed" });
    expect(await stored()).toEqual(before);
  });

  it("blocks hostile/null Origins and non-JSON requests, accepts loopback Vite, and never enables CORS", async () => {
    await writeFile(join(root, "session.jsonl"), content);
    const before = await stored();
    for (const origin of ["https://evil.example", "null", "http://localhost.evil:5173"]) {
      const response = await post(app(), {}, { origin });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden origin" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await stored()).toEqual(before);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      const response = await post(app(), {}, { "content-type": type });
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "application/json required" });
      expect(await stored()).toEqual(before);
    }
    const accepted = await post(app(), {}, { origin: "http://localhost:5173" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(metrics(1));
    expect(accepted.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serializes complete concurrent ingestion requests and health reads", async () => {
    await writeFile(join(root, "a.jsonl"), content);
    await writeFile(join(root, "b.jsonl"), content);
    const application = app();
    const [first, second, health] = await Promise.all([
      post(application),
      post(application),
      application.request("/api/health"),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(metrics(2));
    expect(await second.json()).toEqual(metrics(2, 0, 2));
    expect(health.status).toBe(200);
    expect((await stored()).map((rows) => rows.length)).toEqual([2, 2, 2, 2, 0, 0, 2]);
  });
});
