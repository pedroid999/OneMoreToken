import type { Database } from "@omt/core";
import { Hono } from "hono";

export interface Health {
  status: "ok";
  schemaVersion: number;
}

/** HTTP API. Takes an already migrated database so tests can call `app.request()` without a port. */
export function createApp(db: Database): Hono {
  const app = new Hono();

  app.get("/api/health", async (c) => {
    const rows = await db.all<{ version: number | null }>(
      "SELECT max(version) AS version FROM schema_migrations",
    );
    const body: Health = { status: "ok", schemaVersion: Number(rows[0]?.version ?? 0) };
    return c.json(body);
  });

  return app;
}
