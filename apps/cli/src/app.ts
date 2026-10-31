import { homedir } from "node:os";
import {
  type Database,
  loadSubscriptions,
  loadUserSubscriptions,
  syncCalibrations,
} from "@omt/core";
import { type Context, Hono } from "hono";
import { listCalibrations } from "./calibrations/list";
import {
  CalibrationError,
  createCalibrationStore,
  MAX_CALIBRATION_BODY_BYTES,
} from "./calibrations/store";
import { withDatabase } from "./db-queue";
import { isJsonRequest, readBoundedJson } from "./explorer/http";
import { parseExplorerQuery, readExplorer } from "./explorer/service";
import { readGit } from "./git/service";
import { readIngestJson, safeIngestOrigin } from "./ingest/http";
import { type IngestServiceOptions, ingestSessions } from "./ingest/service";
import { INVALID_INGEST_OPTIONS, validateIngestOptions } from "./ingest-options";
import {
  defaultCalibrationsPath,
  defaultSubscriptionsConfigPath,
  defaultViewsDirectory,
} from "./options";
import { readProfiles } from "./profiles/service";
import { readQuotas } from "./quotas/service";
import { isSessionId, parseSessionsQuery, readSession, readSessions } from "./sessions/service";
import { readSummary, summaryPeriod } from "./summary/service";
import { createViewStore, MAX_VIEW_BYTES, ViewError, type ViewStoreOptions } from "./views/store";

export interface Health {
  status: "ok";
  schemaVersion: number;
}

export interface AppOptions {
  /** Host names accepted besides loopback, e.g. the address passed with `omt serve --host`. */
  allowedHosts?: readonly string[];
  /** Discovery dependencies; roots: [] disables real home-directory discovery in tests. */
  ingest?: IngestServiceOptions;
  /** Saved views storage; tests pass a temporary directory instead of the real data home. */
  views?: Partial<ViewStoreOptions>;
  /** The user's subscriptions config; tests pass a temporary file instead of the real config home. */
  subscriptions?: { configPath?: string };
  /** Manual quota readings; tests pass a temporary file instead of the real data home. */
  calibrations?: { path?: string };
  /** Clock for quota windows and pace projection; tests pin it. */
  quotas?: { now?: () => number };
}

/** Explorer bodies are small: 2 dimensions, 4 metrics, at most 10 filters of 50 values. */
const MAX_EXPLORER_BYTES = 64 * 1024;
const INVALID_EXPLORER_QUERY = "invalid explorer query";

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
    const rows = await withDatabase(db, () =>
      db.all<{ version: number | null }>("SELECT max(version) AS version FROM schema_migrations"),
    );
    const body: Health = { status: "ok", schemaVersion: Number(rows[0]?.version ?? 0) };
    return c.json(body);
  });

  app.get("/api/summary", async (c) => {
    const period = summaryPeriod(new URL(c.req.url).searchParams);
    if (!period) return c.json({ error: "invalid summary period" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readSummary(db, period));
    } catch {
      return c.json({ error: "summary unavailable" }, 500);
    }
  });

  app.get("/api/sessions", async (c) => {
    const query = parseSessionsQuery(new URL(c.req.url).searchParams);
    if (!query) return c.json({ error: "invalid sessions query" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readSessions(db, query));
    } catch {
      return c.json({ error: "sessions unavailable" }, 500);
    }
  });

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!isSessionId(id)) return c.json({ error: "invalid session id" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      const detail = await readSession(db, id);
      return detail ? c.json(detail) : c.json({ error: "session not found" }, 404);
    } catch {
      return c.json({ error: "sessions unavailable" }, 500);
    }
  });

  /** Browser writes need a loopback Origin (or none) and JSON, which forces a CORS preflight. */
  const guardWrite = (c: Context, json: boolean) => {
    if (!safeIngestOrigin(c.req.header("origin"))) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (json && !isJsonRequest(c.req.header("content-type"))) {
      return c.json({ error: "application/json required" }, 415);
    }
    return null;
  };

  app.post("/api/explorer/query", async (c) => {
    const rejected = guardWrite(c, true);
    if (rejected) return rejected;
    let request: ReturnType<typeof parseExplorerQuery> = null;
    try {
      request = parseExplorerQuery(await readBoundedJson(c.req.raw, MAX_EXPLORER_BYTES));
    } catch {
      // Malformed or oversized: same fixed diagnostic as any invalid query.
    }
    if (!request) return c.json({ error: INVALID_EXPLORER_QUERY }, 400);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readExplorer(db, request));
    } catch {
      return c.json({ error: "explorer unavailable" }, 500);
    }
  });

  const views = createViewStore({
    directory: options.views?.directory ?? defaultViewsDirectory(process.env, homedir()),
    ...(options.views?.presetsDirectory
      ? { presetsDirectory: options.views.presetsDirectory }
      : {}),
  });
  const viewFailure = (c: Context, error: unknown) =>
    error instanceof ViewError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "views unavailable" }, 500);

  app.get("/api/views", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await views.list());
    } catch (error) {
      return viewFailure(c, error);
    }
  });

  app.put("/api/views/:id", async (c) => {
    const rejected = guardWrite(c, true);
    if (rejected) return rejected;
    let input: unknown;
    try {
      input = await readBoundedJson(c.req.raw, MAX_VIEW_BYTES);
    } catch {
      return c.json({ error: "invalid view" }, 400);
    }
    try {
      return c.json(await views.put(c.req.param("id"), input));
    } catch (error) {
      return viewFailure(c, error);
    }
  });

  app.delete("/api/views/:id", async (c) => {
    const rejected = guardWrite(c, false);
    if (rejected) return rejected;
    try {
      await views.remove(c.req.param("id"));
      return c.body(null, 204);
    } catch (error) {
      return viewFailure(c, error);
    }
  });

  const subscriptionsConfigPath =
    options.subscriptions?.configPath ?? defaultSubscriptionsConfigPath(process.env, homedir());
  const calibrations = createCalibrationStore(
    options.calibrations?.path ?? defaultCalibrationsPath(process.env, homedir()),
    () => {
      const plans = loadSubscriptions();
      const config = loadUserSubscriptions(subscriptionsConfigPath, plans);
      if (!config.ok) return null;
      const windows = new Map(
        plans.plans.map((plan) => [plan.id, plan.windows.map((w) => w.kind)]),
      );
      return new Map(
        config.file.subscriptions.map((s) => [s.id, new Set(windows.get(s.planId) ?? [])]),
      );
    },
  );
  const calibrationFailure = (c: Context, error: unknown) =>
    error instanceof CalibrationError
      ? c.json({ error: error.message }, error.status)
      : c.json({ error: "calibrations unavailable" }, 500);

  app.get("/api/calibrations", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      return c.json({
        calibrations: await listCalibrations(db, calibrations, subscriptionsConfigPath),
      });
    } catch (error) {
      return calibrationFailure(c, error);
    }
  });

  app.post("/api/calibrations", async (c) => {
    const rejected = guardWrite(c, true);
    if (rejected) return rejected;
    let input: unknown;
    try {
      input = await readBoundedJson(c.req.raw, MAX_CALIBRATION_BODY_BYTES);
    } catch {
      return c.json({ error: "invalid calibration" }, 400);
    }
    try {
      const entry = await calibrations.add(input);
      const all = await calibrations.list();
      await withDatabase(db, () => syncCalibrations(db, all));
      return c.json(entry, 201);
    } catch (error) {
      return calibrationFailure(c, error);
    }
  });

  app.delete("/api/calibrations/:id", async (c) => {
    const rejected = guardWrite(c, false);
    if (rejected) return rejected;
    try {
      const kept = await calibrations.remove(c.req.param("id"));
      await withDatabase(db, () => syncCalibrations(db, kept));
      return c.body(null, 204);
    } catch (error) {
      return calibrationFailure(c, error);
    }
  });

  const quotasNow = options.quotas?.now ?? (() => Date.now());

  app.get("/api/quotas", async (c) => {
    const now = quotasNow();
    const period = summaryPeriod(new URL(c.req.url).searchParams, now);
    if (!period) return c.json({ error: "invalid quotas period" }, 400);
    c.header("Cache-Control", "no-store");
    // A corrupt or unsafe calibrations file degrades to quotas without readings, never a failure.
    const readings = await calibrations.list().catch(() => null);
    try {
      return c.json(
        await readQuotas(db, {
          period,
          configPath: subscriptionsConfigPath,
          calibrations: readings,
          now,
        }),
      );
    } catch {
      return c.json({ error: "quotas unavailable" }, 500);
    }
  });

  app.get("/api/profiles", async (c) => {
    const period = summaryPeriod(new URL(c.req.url).searchParams, quotasNow());
    if (!period) return c.json({ error: "invalid profiles period" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readProfiles(db, { period, configPath: subscriptionsConfigPath }));
    } catch {
      return c.json({ error: "profiles unavailable" }, 500);
    }
  });

  app.get("/api/git", async (c) => {
    const period = summaryPeriod(new URL(c.req.url).searchParams, quotasNow());
    if (!period) return c.json({ error: "invalid git period" }, 400);
    c.header("Cache-Control", "no-store");
    try {
      return c.json(await readGit(db, period));
    } catch {
      return c.json({ error: "git unavailable" }, 500);
    }
  });

  app.post("/api/ingest", async (c) => {
    if (!safeIngestOrigin(c.req.header("origin"))) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (
      c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    ) {
      return c.json({ error: "application/json required" }, 415);
    }
    let input: unknown;
    try {
      input = await readIngestJson(c.req.raw);
    } catch {
      return c.json({ error: INVALID_INGEST_OPTIONS }, 400);
    }
    const parsed = validateIngestOptions(input);
    if (!parsed) return c.json({ error: INVALID_INGEST_OPTIONS }, 400);
    try {
      return c.json(await ingestSessions(db, parsed, options.ingest));
    } catch {
      return c.json({ error: "ingestion failed" }, 500);
    }
  });

  return app;
}
