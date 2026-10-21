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
    expect(await res.json()).toEqual({ status: "ok", schemaVersion: 3 });
  });

  it("returns 404 for unknown API routes", async () => {
    db = await openDatabase(":memory:");
    await migrate(db);

    const res = await createApp(db).request("/api/nope");

    expect(res.status).toBe(404);
  });

  it.each(["localhost", "localhost:7317", "127.0.0.1:7317", "[::1]:7317"])(
    "accepts the loopback Host header %s",
    async (host) => {
      db = await openDatabase(":memory:");
      await migrate(db);

      const res = await createApp(db).request("/api/health", { headers: { host } });

      expect(res.status).toBe(200);
    },
  );

  it.each(["evil.example", "evil.example:7317", "192.168.1.10:7317"])(
    "rejects a foreign Host header %s with 403 to block DNS rebinding",
    async (host) => {
      db = await openDatabase(":memory:");
      await migrate(db);

      const res = await createApp(db).request("/api/health", { headers: { host } });

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden host" });
    },
  );

  it("rejects a foreign host taken from the request URL when no Host header is sent", async () => {
    db = await openDatabase(":memory:");
    await migrate(db);

    const res = await createApp(db).request("http://evil.example/api/health");

    expect(res.status).toBe(403);
  });

  it("accepts extra allowed hosts, such as the one passed with --host", async () => {
    db = await openDatabase(":memory:");
    await migrate(db);

    const res = await createApp(db, { allowedHosts: ["omt.lan"] }).request("/api/health", {
      headers: { host: "omt.lan:7317" },
    });

    expect(res.status).toBe(200);
  });
});
