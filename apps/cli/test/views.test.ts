import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, loadPresetViews, migrate, openDatabase } from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { defaultViewsDirectory } from "../src/options";
import type { ViewList } from "../src/views/store";

let db: Database;
let home: string;
let directory: string;
const presets = loadPresetViews();
const presetId = presets[0]?.id ?? "";

const view = (id: string, name = "My cost view") => ({
  schema: "omt.saved-view/1",
  id,
  name,
  query: { metrics: ["computedCost"], dimensions: ["model"], filters: [], range: "last7Days" },
  chart: { type: "bar", encoding: { x: "model", y: "computedCost" } },
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "table" },
    mark: "bar",
    encoding: { x: { field: "model" }, y: { field: "computedCost", type: "quantitative" } },
  },
});

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-views-"));
  directory = join(home, "data", "one-more-token", "views");
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const app = () => createApp(db, { views: { directory } });
const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  app().request(`/api/views/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const del = (id: string, headers: Record<string, string> = {}) =>
  app().request(`/api/views/${id}`, { method: "DELETE", headers });
const list = async () => {
  const response = await app().request("/api/views");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as ViewList;
};
const mode = (path: string) => statSync(path).mode & 0o777;

describe("defaultViewsDirectory (L16)", () => {
  it("uses the data home of the default database, independent of OMT_DB", () => {
    expect(
      defaultViewsDirectory({ XDG_DATA_HOME: "/xdg", OMT_DB: "/elsewhere/x.duckdb" }, "/h"),
    ).toBe("/xdg/one-more-token/views");
    expect(defaultViewsDirectory({}, "/h")).toBe("/h/.local/share/one-more-token/views");
  });
});

describe("GET /api/views (S13)", () => {
  it("lists the read-only presets when no user view exists, without creating anything", async () => {
    expect(presets).toHaveLength(5);
    expect(await list()).toEqual({
      views: presets.map((preset) => ({ origin: "preset", ...preset })),
      invalid: [],
    });
    expect(existsSync(directory)).toBe(false);
  });

  it("lists presets and user views tagged by origin; corrupt or symlinked files are reported, not fatal", async () => {
    expect((await put("mine", view("mine"))).status).toBe(200);
    writeFileSync(join(directory, "broken.json"), "{");
    writeFileSync(join(directory, "wrong-id.json"), JSON.stringify(view("other")));
    writeFileSync(join(home, "outside.json"), JSON.stringify(view("linked")));
    symlinkSync(join(home, "outside.json"), join(directory, "linked.json"));
    writeFileSync(join(directory, "notes.txt"), "ignored");
    const body = await list();
    expect(body.views).toEqual([
      ...presets.map((preset) => ({ origin: "preset", ...preset })),
      { origin: "user", ...view("mine") },
    ]);
    expect(body.invalid).toEqual([{ id: "broken" }, { id: "linked" }, { id: "wrong-id" }]);
  });

  it("refuses to read a symlinked views directory", async () => {
    const real = join(home, "real");
    mkdirSync(real);
    writeFileSync(join(real, "mine.json"), JSON.stringify(view("mine")));
    mkdirSync(join(directory, ".."), { recursive: true });
    symlinkSync(real, directory);
    const response = await app().request("/api/views");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unsafe view storage" });
  });
});

describe("PUT /api/views/:id (S9, S13)", () => {
  it("creates a user view atomically with 0600 file and 0700 directory modes", async () => {
    const response = await put("mine", view("mine"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ origin: "user", ...view("mine") });
    expect(JSON.parse(readFileSync(join(directory, "mine.json"), "utf8"))).toEqual(view("mine"));
    expect(mode(join(directory, "mine.json"))).toBe(0o600);
    expect(mode(directory)).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["mine.json"]);
  });

  it("replaces an existing user view and tightens a permissive directory", async () => {
    mkdirSync(directory, { recursive: true, mode: 0o755 });
    expect((await put("mine", view("mine"))).status).toBe(200);
    expect((await put("mine", view("mine", "Renamed"))).status).toBe(200);
    expect(JSON.parse(readFileSync(join(directory, "mine.json"), "utf8")).name).toBe("Renamed");
    expect(mode(directory)).toBe(0o700);
    expect(readdirSync(directory)).toEqual(["mine.json"]);
  });

  it("serializes concurrent writes so the stored file is always one complete view", async () => {
    const names = Array.from({ length: 8 }, (_, i) => `Name ${i}`);
    const responses = await Promise.all(names.map((name) => put("mine", view("mine", name))));
    expect(responses.map((r) => r.status)).toEqual(names.map(() => 200));
    expect(names.map((name) => view("mine", name))).toContainEqual(
      JSON.parse(readFileSync(join(directory, "mine.json"), "utf8")),
    );
    expect(readdirSync(directory)).toEqual(["mine.json"]);
  });

  it.each([
    ["uppercase id", "Mine", view("Mine")],
    ["traversal id", "..%2Foutside", view("mine")],
    ["underscore id", "my_view", view("my_view")],
    ["long id", "a".repeat(65), view("a".repeat(65))],
    ["body id mismatch", "mine", view("other")],
    ["invalid view", "mine", { ...view("mine"), query: { metrics: ["tokens"] } }],
    ["extra key", "mine", { ...view("mine"), owner: "me" }],
    ["malformed JSON", "mine", "{"],
    ["oversized body", "mine", { ...view("mine"), description: "x".repeat(300 * 1024) }],
  ])("rejects %s with nothing written", async (_label, id, body) => {
    const response = await put(id, body);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid view" });
    expect(existsSync(directory)).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it("rejects a view whose stored JSON would exceed 256 KB", async () => {
    // Compact body below the limit; the pretty-printed stored file is above it.
    const big = { ...view("mine"), spec: { ...view("mine").spec, padding: Array(120000).fill(0) } };
    expect(JSON.stringify(big).length).toBeLessThan(256 * 1024);
    const response = await put("mine", big);
    expect(response.status).toBe(400);
    expect(existsSync(directory)).toBe(false);
  });

  it("never follows a symlinked target file", async () => {
    mkdirSync(directory, { recursive: true });
    const outside = join(home, "outside.json");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(directory, "mine.json"));
    const response = await put("mine", view("mine"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "unsafe view storage" });
    expect(readFileSync(outside, "utf8")).toBe("keep");
    expect(lstatSync(join(directory, "mine.json")).isSymbolicLink()).toBe(true);
    expect(readdirSync(directory)).toEqual(["mine.json"]);
  });

  it("never writes through a symlinked views directory", async () => {
    const real = join(home, "real");
    mkdirSync(real);
    mkdirSync(join(directory, ".."), { recursive: true });
    symlinkSync(real, directory);
    const response = await put("mine", view("mine"));
    expect(response.status).toBe(409);
    expect(readdirSync(real)).toEqual([]);
  });

  it("keeps presets immutable", async () => {
    const response = await put(presetId, view(presetId));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "preset views are read-only" });
    expect(existsSync(directory)).toBe(false);
  });

  it("requires JSON, a local Host and no hostile browser Origin", async () => {
    expect((await put("mine", view("mine"), { "content-type": "text/plain" })).status).toBe(415);
    expect((await put("mine", view("mine"), { origin: "https://evil.example" })).status).toBe(403);
    expect((await put("mine", view("mine"), { host: "evil.example" })).status).toBe(403);
    expect(existsSync(directory)).toBe(false);
  });
});

describe("DELETE /api/views/:id (S13)", () => {
  it("deletes only user views", async () => {
    expect((await put("mine", view("mine"))).status).toBe(200);
    const response = await del("mine");
    expect(response.status).toBe(204);
    expect(readdirSync(directory)).toEqual([]);
    expect((await list()).views.filter((entry) => entry.origin === "user")).toEqual([]);
    expect((await del("mine")).status).toBe(404);
  });

  it("refuses presets, invalid ids, symlinks and hostile requests without touching files", async () => {
    expect((await put("mine", view("mine"))).status).toBe(200);
    const outside = join(home, "outside.json");
    writeFileSync(outside, "keep");
    symlinkSync(outside, join(directory, "linked.json"));
    expect((await del(presetId)).status).toBe(403);
    expect((await del("..%2Foutside")).status).toBe(400);
    expect((await del("linked")).status).toBe(409);
    expect((await del("mine", { origin: "https://evil.example" })).status).toBe(403);
    expect((await del("mine", { host: "evil.example" })).status).toBe(403);
    expect(readdirSync(directory).sort()).toEqual(["linked.json", "mine.json"]);
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });
});
