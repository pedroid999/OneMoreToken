import { type Database, migrate, openDatabase } from "@omt/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("GET /api/health", () => {
  let db: Database | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("reports ok and the highest applied migration version", async () => {
    db = await openDatabase(":memory:");
    await migrate(db);

    const res = await createApp(db).request("/api/health");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "ok", schemaVersion: 1 });
  });

  it("returns 404 for unknown API routes", async () => {
    db = await openDatabase(":memory:");
    await migrate(db);

    const res = await createApp(db).request("/api/nope");

    expect(res.status).toBe(404);
  });
});
