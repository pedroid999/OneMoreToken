import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";

let db: Database;
let home: string;
let configPath: string;
let calibrationsPath: string;

const NOW = Date.parse("2026-10-10T11:00:00.000Z");
const PERIOD = "from=2026-10-01T00:00:00.000Z&to=2026-10-11T00:00:00.000Z";

const CURRENT_PRICING = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

const config = {
  version: 1,
  subscriptions: [
    { id: "go", planId: "opencode-go", match: [{ provider: "opencode-go" }] },
    { id: "claude", planId: "claude-pro", match: [{ provider: "claude-bridge" }] },
  ],
};

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-quotas-"));
  configPath = join(home, "subscriptions.json");
  calibrationsPath = join(home, "calibrations.json");
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, started_at, format_version) VALUES
      ('s', 'src', 'gentle-shell', '2026-10-10T09:00:00Z', '3')`,
  );
  await db.run(
    `INSERT INTO ingest_checkpoints VALUES ('src', 'content', '1', '2026-10-10T12:00:00Z', $1)`,
    [CURRENT_PRICING],
  );
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, provider) VALUES
      ('go-1', 's', 0, 'assistant', '2026-10-10T10:00:00Z', 'opencode-go'),
      ('go-2', 's', 1, 'assistant', '2026-10-10T10:30:00Z', 'opencode-go'),
      ('claude-1', 's', 2, 'assistant', '2026-10-10T10:00:00Z', 'claude-bridge'),
      ('api-1', 's', 3, 'assistant', '2026-10-10T10:15:00Z', 'anthropic')`,
  );
  await db.run(
    `INSERT INTO usage (turn_id, input_tokens, output_tokens, reported_cost_usd, computed_cost_usd) VALUES
      ('go-1', 100, 50, 3, 9),
      ('go-2', 10, 0, NULL, 3),
      ('claude-1', 1000, 0, NULL, 2),
      ('api-1', 5000, 0, 100, 100)`,
  );
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const app = () =>
  createApp(db, {
    subscriptions: { configPath },
    calibrations: { path: calibrationsPath },
    quotas: { now: () => NOW },
  });
const get = (query = PERIOD) => app().request(`/api/quotas?${query}`);

interface Body {
  config: { status: string };
  calibrations: { status: string };
  subscriptions: {
    id: string;
    windows: {
      kind: string;
      limitSource: string;
      limitUsd: number | null;
      windows: Record<string, unknown>[];
      current: Record<string, unknown> | null;
      projection: Record<string, unknown> | null;
    }[];
    extractedValue: { apiEquivalentUsd: number; unpricedTurns: number };
  }[];
}
const kind = (body: Body, id: string, name: string) =>
  body.subscriptions.find((s) => s.id === id)?.windows.find((w) => w.kind === name);

describe("/api/quotas", () => {
  it("answers status missing and no subscriptions without a local config", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      config: { status: "missing" },
      calibrations: { status: "ok" },
      subscriptions: [],
    });
  });

  it("answers status invalid without leaking details for a broken config", async () => {
    writeFileSync(configPath, "{ not json");
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      config: { status: "invalid" },
      calibrations: { status: "ok" },
      subscriptions: [],
    });
  });

  it("computes windows per subscription and excludes turns without a subscription", async () => {
    writeFileSync(configPath, JSON.stringify(config));
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Body;
    expect(body.config).toEqual({ status: "ok" });
    expect(body.calibrations).toEqual({ status: "ok" });
    expect(body.subscriptions.map((s) => s.id)).toEqual(["go", "claude"]);

    const five = kind(body, "go", "five_hours");
    expect(five?.limitSource).toBe("plan");
    expect(five?.windows).toEqual([
      {
        startsAt: "2026-10-10T10:00:00.000Z",
        endsAt: "2026-10-10T15:00:00.000Z",
        usedUsd: 6,
        usedTokens: 160,
        limitUsd: 12,
        limitTokens: null,
        estimatedPct: 50,
        overLimitUsd: 0,
        limitSource: "plan",
        estimated: true,
      },
    ]);
    // 6 usd in the first hour of a 12 usd window: the limit is reached at 12:00, before 15:00.
    expect(five?.projection).toEqual({
      projectedLimitAt: "2026-10-10T12:00:00.000Z",
      reached: false,
      estimated: true,
    });

    const claude = kind(body, "claude", "five_hours");
    expect(claude?.limitSource).toBe("unknown");
    expect(claude?.windows[0]).toMatchObject({ usedUsd: 2, estimatedPct: null, estimated: true });

    // The pay-as-you-go turn (provider anthropic) never reaches a subscription.
    const used = body.subscriptions.flatMap((s) =>
      s.windows.flatMap((w) => w.windows.map((x) => x.usedUsd as number)),
    );
    expect(used.every((usd) => usd < 100)).toBe(true);
    expect(body.subscriptions.map((s) => s.extractedValue.apiEquivalentUsd)).toEqual([12, 2]);
  });

  it("syncs calibrations and refreshes quota_windows as a derived cache", async () => {
    writeFileSync(configPath, JSON.stringify(config));
    writeFileSync(
      calibrationsPath,
      JSON.stringify({
        version: 1,
        calibrations: [
          {
            id: "r1",
            subscriptionId: "claude",
            windowKind: "five_hours",
            observedAt: "2026-10-10T10:30:00Z",
            observedPct: 20,
          },
        ],
      }),
    );
    await db.run(
      `INSERT INTO quota_windows (id, subscription_id, kind, starts_at, ends_at)
       VALUES ('stale', 'gone', 'weekly', '2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z')`,
    );
    const body = (await (await get()).json()) as Body;
    const claude = kind(body, "claude", "five_hours");
    expect(claude?.limitSource).toBe("calibrated");
    expect(claude?.limitUsd).toBe(10);
    expect(claude?.windows[0]).toMatchObject({ estimatedPct: 20 });
    expect(
      (claude as unknown as { calibration: { readings: unknown[] } }).calibration.readings,
    ).toEqual([expect.objectContaining({ id: "r1", origin: "manual" })]);

    expect(await db.all("SELECT id, observed_pct FROM calibrations")).toEqual([
      { id: "r1", observed_pct: 20 },
    ]);
    const cached = await db.all<{ id: string; used_usd: number; limit_usd: number | null }>(
      "SELECT id, used_usd, limit_usd, estimated_pct FROM quota_windows ORDER BY id",
    );
    expect(cached.map((row) => row.id)).not.toContain("stale");
    expect(cached).toContainEqual({
      id: "go:five_hours:2026-10-10T10:00:00.000Z",
      used_usd: 6,
      limit_usd: 12,
      estimated_pct: 50,
    });
    expect(cached).toContainEqual({
      id: "claude:five_hours:2026-10-10T10:00:00.000Z",
      used_usd: 2,
      limit_usd: 10,
      estimated_pct: 20,
    });
  });

  it("calibrates a Codex subscription with the latest provider reading per window", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        subscriptions: [
          {
            id: "plus",
            planId: "chatgpt-plus",
            startedAt: "2026-10-01",
            match: [{ provider: "openai", agent: "codex" }],
          },
        ],
      }),
    );
    await db.run(
      `INSERT INTO sessions (id, source_id, agent, started_at, format_version) VALUES
        ('cx', 'src', 'codex', '2026-10-10T10:00:00Z', 'codex-rollout/1')`,
    );
    await db.run(
      `INSERT INTO turns (id, session_id, idx, role, ts, provider) VALUES
        ('cx-1', 'cx', 0, 'assistant', '2026-10-10T10:00:00Z', 'openai'),
        ('cx-2', 'cx', 1, 'assistant', '2026-10-10T10:30:00Z', 'openai')`,
    );
    await db.run(
      `INSERT INTO usage (turn_id, input_tokens, output_tokens, computed_cost_usd) VALUES
        ('cx-1', 10, 0, 4), ('cx-2', 10, 0, 2)`,
    );
    await db.run(
      `INSERT INTO provider_quota_readings VALUES
        ('r1', 'src', 'codex', 'five_hours', '2026-10-10T10:15:00Z', 10, '2026-10-10T15:00:00Z'),
        ('r2', 'src', 'codex', 'five_hours', '2026-10-10T10:45:00Z', 30, '2026-10-10T15:00:00Z'),
        ('w1', 'src', 'codex', 'weekly', '2026-10-10T10:45:00Z', 3, '2026-10-15T00:00:00Z'),
        ('r0', 'src', 'codex', 'five_hours', '2026-09-30T10:00:00Z', 50, '2026-09-30T15:00:00Z')`,
    );
    const body = (await (await get()).json()) as Body & {
      subscriptions: { windows: { calibration: { readings: Record<string, unknown>[] } }[] }[];
    };
    const five = kind(body, "plus", "five_hours") as (typeof body.subscriptions)[0]["windows"][0] &
      Body["subscriptions"][0]["windows"][0];
    // r2: 6 USD at 30% implies a 20 USD limit; r1 is an earlier reading of the same window and r0
    // predates the subscription, so neither counts.
    expect(five.limitSource).toBe("calibrated");
    expect(five.limitUsd).toBeCloseTo(20);
    expect(five.calibration.readings).toEqual([
      expect.objectContaining({ id: "r2", origin: "codex", observedPct: 30, usedUsd: 6 }),
    ]);
    const weekly = kind(body, "plus", "weekly") as typeof five;
    expect(weekly.limitUsd).toBeCloseTo(200);
    expect(weekly.calibration.readings.map((r) => [r.id, r.origin])).toEqual([["w1", "codex"]]);
    // Derived data only: nothing is mirrored into the manual calibrations table.
    expect(await db.all("SELECT * FROM calibrations")).toEqual([]);
  });

  it("follows config edits without a re-ingest", async () => {
    writeFileSync(configPath, JSON.stringify(config));
    await get();
    writeFileSync(
      configPath,
      JSON.stringify({ version: 1, subscriptions: [config.subscriptions[1]] }),
    );
    const body = (await (await get()).json()) as Body;
    expect(body.subscriptions.map((s) => s.id)).toEqual(["claude"]);
  });

  it.each([
    ["only one bound", "from=2026-10-01T00:00:00.000Z"],
    ["reversed bounds", "from=2026-10-11T00:00:00.000Z&to=2026-10-01T00:00:00.000Z"],
    ["a malformed date", "from=yesterday&to=2026-10-01T00:00:00.000Z"],
  ])("rejects %s with a fixed error", async (_name, query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid quotas period" });
  });

  it.each([
    ["corrupt", () => writeFileSync(calibrationsPath, "{")],
    [
      "symlinked",
      () => {
        const target = join(home, "elsewhere.json");
        writeFileSync(target, JSON.stringify({ version: 1, calibrations: [] }));
        symlinkSync(target, calibrationsPath);
      },
    ],
  ])(
    "computes quotas without a %s calibrations file and keeps the mirror",
    async (_name, setup) => {
      writeFileSync(configPath, JSON.stringify(config));
      setup();
      await db.run(
        `INSERT INTO calibrations VALUES ('kept', 'claude', 'five_hours', '2026-10-10T10:30:00Z', 20, NULL)`,
      );
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = (await response.json()) as Body;
      expect(body.config).toEqual({ status: "ok" });
      expect(body.calibrations).toEqual({ status: "invalid" });
      expect(kind(body, "claude", "five_hours")?.limitSource).toBe("unknown");
      expect(kind(body, "go", "five_hours")?.windows[0]).toMatchObject({ usedUsd: 6 });
      expect(await db.all("SELECT id FROM calibrations")).toEqual([{ id: "kept" }]);
      // The calibrations endpoints keep refusing the unsafe file.
      expect((await app().request("/api/calibrations")).status).toBe(409);
    },
  );

  it("treats computed cost priced with an outdated or missing pricing hash as unpriced", async () => {
    writeFileSync(configPath, JSON.stringify(config));
    await db.run(
      `INSERT INTO sessions (id, source_id, agent, started_at, format_version) VALUES
        ('old', 'old-src', 'gentle-shell', '2026-10-10T09:00:00Z', '3'),
        ('bare', 'bare-src', 'gentle-shell', '2026-10-10T09:00:00Z', '3')`,
    );
    await db.run(
      `INSERT INTO ingest_checkpoints VALUES ('old-src', 'c', '1', '2026-10-10T12:00:00Z', 'outdated')`,
    );
    await db.run(
      `INSERT INTO turns (id, session_id, idx, role, ts, provider) VALUES
        ('go-old', 'old', 0, 'assistant', '2026-10-10T10:40:00Z', 'opencode-go'),
        ('go-bare', 'bare', 0, 'assistant', '2026-10-10T10:50:00Z', 'opencode-go'),
        ('go-old-reported', 'old', 1, 'assistant', '2026-10-10T10:45:00Z', 'opencode-go')`,
    );
    await db.run(
      `INSERT INTO usage (turn_id, input_tokens, output_tokens, reported_cost_usd, computed_cost_usd) VALUES
        ('go-old', 1, 0, NULL, 50),
        ('go-bare', 1, 0, NULL, 40),
        ('go-old-reported', 1, 0, 1, 70)`,
    );
    const body = (await (await get()).json()) as Body;
    const five = kind(body, "go", "five_hours");
    // Reported cost still counts; stale computed cost does not.
    expect(five?.windows[0]).toMatchObject({ usedUsd: 7, usedTokens: 163 });
    const go = body.subscriptions.find((s) => s.id === "go");
    expect(go?.extractedValue).toMatchObject({ apiEquivalentUsd: 12, unpricedTurns: 3 });
  });
});
