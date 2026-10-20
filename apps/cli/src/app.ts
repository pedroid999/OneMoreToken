import type { Database } from "@omt/core";
import { Hono } from "hono";

export interface Health {
  status: "ok";
  schemaVersion: number;
}

export interface AppOptions {
  /** Host names accepted besides loopback, e.g. the address passed with `omt serve --host`. */
  allowedHosts?: readonly string[];
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Host name without port or IPv6 brackets: "[::1]:7317" -> "::1", "localhost:7317" -> "localhost". */
export function hostnameOf(host: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed?.[1]) return bracketed[1].toLowerCase();
  return host.replace(/:\d+$/, "").toLowerCase();
}

/**
 * HTTP API. Takes an already migrated database so tests can call `app.request()` without a port.
 * Requests whose Host is not loopback (or explicitly allowed) get 403: binding to 127.0.0.1 alone
 * does not stop a malicious page from reading the API through DNS rebinding.
 */
export function createApp(db: Database, options: AppOptions = {}): Hono {
  const app = new Hono();
  const allowed = new Set([...LOOPBACK_HOSTS, ...(options.allowedHosts ?? []).map(hostnameOf)]);

  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!allowed.has(hostnameOf(host))) return c.json({ error: "forbidden host" }, 403);
    await next();
  });

  app.get("/api/health", async (c) => {
    const rows = await db.all<{ version: number | null }>(
      "SELECT max(version) AS version FROM schema_migrations",
    );
    const body: Health = { status: "ok", schemaVersion: Number(rows[0]?.version ?? 0) };
    return c.json(body);
  });

  return app;
}
