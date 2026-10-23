import {
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { NormalizedBatchSchema, type ParseContext } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenCodeFixture } from "./fixtures/create";
import { OPENCODE_ADAPTER_VERSION, parseOpenCode } from "./index";
import { readOpenCodeSessions } from "./reader";

let root: string;
let scratch: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "omt-opencode-root-"));
  scratch = await mkdtemp(join(tmpdir(), "omt-opencode-scratch-"));
});
afterEach(async () => {
  for (const dir of [root, scratch]) await rm(dir, { recursive: true, force: true });
});

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}
async function fingerprint(dir: string) {
  return Promise.all(
    (await files(dir)).map(async (name) => {
      const info = await stat(join(dir, name));
      return [name, info.size, info.mtimeMs, (await readFile(join(dir, name))).toString("hex")];
    }),
  );
}
const read = (dir = root, options = {}) =>
  readOpenCodeSessions(dir, { tmpdir: scratch, ...options });
const parseAll = (result: Awaited<ReturnType<typeof read>>) =>
  result.sessions.map((session) => {
    const context: ParseContext = {
      agent: "opencode",
      path: join("/synthetic/opencode/sessions", relative(join(root, "sessions"), session.path)),
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      ingestedAt: "2026-01-10T00:00:00.000Z",
      pricing: { version: 1, currency: "USD", entries: [] },
    };
    return NormalizedBatchSchema.parse(parseOpenCode(session.content, context));
  });

describe("OpenCode reader", () => {
  it("projects SQLite (with WAL) and legacy-only sessions read-only, without locks or content", async () => {
    await createOpenCodeFixture(root);
    expect((await stat(join(root, "opencode.db-wal"))).size).toBeGreaterThan(0);
    const before = await fingerprint(root);
    const result = await read();
    expect(await fingerprint(root)).toEqual(before);
    expect(await files(root)).not.toContain("opencode.db-shm");
    expect(await readdir(scratch)).toEqual([]);
    expect(result.failures).toBe(0);
    expect(result.sessions.map(({ path }) => relative(root, path))).toEqual([
      "sessions/ses_child",
      "sessions/ses_legacy_dup",
      "sessions/ses_parent",
      "sessions/ses_legacy_only",
    ]);
    expect(result.sessions.map(({ updated }) => updated)).toEqual([
      1767225720000, 1764547260000, 1767226200000, 1759277100000,
    ]);
    const text = JSON.stringify(result);
    expect(text).not.toContain("PRIVATE_SENTINEL");
    expect(text).not.toContain("step-");
    const documents = result.sessions.map(({ content }) => JSON.parse(content));
    // SQLite wins: the migrated legacy copy (cost 99) is ignored.
    expect(documents[1]).toMatchObject({ origin: "sqlite", messages: [{ cost: 0.25 }] });
    expect(documents).toMatchSnapshot();
    expect(await read()).toEqual(result);
    const batches = parseAll(result);
    expect(
      batches.map((batch) => batch.issues.map(({ code, location }) => [code, location])),
    ).toEqual([[], [], [["missing_usage", "10"]], [["invalid_json", "5"]]]);
    expect(batches).toMatchSnapshot();
  });

  it("needs the WAL: a main-file-only copy is unreadable and then legacy is not trusted", async () => {
    await createOpenCodeFixture(root);
    const partial = await mkdtemp(join(tmpdir(), "omt-opencode-main-only-"));
    try {
      await copyFile(join(root, "opencode.db"), join(partial, "opencode.db"));
      const result = await read(partial);
      expect(result).toEqual({ sessions: [], failures: 1 });
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  });

  it("ingests every legacy session when the database is missing", async () => {
    await createOpenCodeFixture(root, { sqlite: false });
    await writeFile(join(root, "storage", "session", "prj_synthetic", "ses_bad.json"), "{");
    const result = await read();
    expect(result.failures).toBe(1);
    expect(result.sessions.map(({ path }) => relative(root, path))).toEqual([
      "sessions/ses_legacy_dup",
      "sessions/ses_legacy_only",
    ]);
    expect(JSON.parse(result.sessions[0]?.content ?? "")).toMatchObject({
      origin: "legacy",
      messages: [{ cost: 99, parts: [{ type: "tool", tool: "read", status: "completed" }] }],
    });
  });

  it("retries once when the database changes during the copy, then reports a failure", async () => {
    await createOpenCodeFixture(root);
    let calls = 0;
    const touching = (limit: number) => async (source: string, target: string, mode?: number) => {
      await copyFile(source, target, mode);
      if (calls++ < limit) {
        const later = new Date(Date.now() + 60000 * calls);
        await utimes(join(root, "opencode.db-wal"), later, later);
      }
    };
    const retried = await read(root, { copyFile: touching(1) });
    expect(retried.failures).toBe(0);
    expect(retried.sessions).toHaveLength(4);
    calls = 0;
    expect(await read(root, { copyFile: touching(Number.POSITIVE_INFINITY) })).toEqual({
      sessions: [],
      failures: 1,
    });
    expect(await readdir(scratch)).toEqual([]);
  });

  it("does not follow a symlinked database or storage directory", async () => {
    const real = await mkdtemp(join(tmpdir(), "omt-opencode-real-"));
    try {
      await createOpenCodeFixture(real);
      await symlink(join(real, "opencode.db"), join(root, "opencode.db"));
      await symlink(join(real, "storage"), join(root, "storage"));
      expect(await read()).toEqual({ sessions: [], failures: 0 });
    } finally {
      await rm(real, { recursive: true, force: true });
    }
  });
});
