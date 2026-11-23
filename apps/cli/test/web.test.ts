import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { readWebFile } from "../src/web/static";

let db: Database | undefined;
let dir: string | undefined;

function makeDist(): string {
  const root = mkdtempSync(join(tmpdir(), "omt-web-"));
  writeFileSync(join(root, "index.html"), "<html>dashboard</html>\n");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)\n");
  writeFileSync(join(root, "assets", "app.css"), "body{}\n");
  return root;
}

afterEach(() => {
  db?.close();
  db = undefined;
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

async function appWithDist(dist?: string) {
  db = await openDatabase(":memory:");
  await migrate(db);
  return createApp(db, dist === undefined ? { web: {} } : { web: { dist } });
}

describe("built dashboard static serving", () => {
  it("serves index.html at the root when dist exists", async () => {
    dir = makeDist();
    const res = await (await appWithDist(dir)).request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("dashboard");
  });

  it("serves asset files with their content type", async () => {
    dir = makeDist();
    const app = await appWithDist(dir);
    const js = await app.request("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const css = await app.request("/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("css");
  });

  it("rejects path traversal at the file resolver", async () => {
    dir = makeDist();
    expect(await readWebFile(dir, "../index.html")).toBeNull();
    expect(await readWebFile(dir, "/../secrets.txt")).toBeNull();
    expect(await readWebFile(dir, "assets/../../outside.txt")).toBeNull();
  });

  it("falls back to index.html for unknown non-API paths (SPA routes)", async () => {
    dir = makeDist();
    const res = await (await appWithDist(dir)).request("/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("dashboard");
  });

  it("keeps API 404s as JSON when dist exists", async () => {
    dir = makeDist();
    const res = await (await appWithDist(dir)).request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("json");
  });

  it("returns a plain 404 page for non-API paths when no dist exists", async () => {
    const res = await (await appWithDist(undefined)).request("/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).not.toContain("dashboard");
  });
});
