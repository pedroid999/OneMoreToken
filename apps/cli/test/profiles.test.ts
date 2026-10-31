import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { ProfileFigures, ProfilesResponse } from "../src/profiles/contract";

let db: Database;
let home: string;
let configPath: string;

const PERIOD = "from=2026-10-01T00:00:00.000Z&to=2026-10-11T00:00:00.000Z";
const CURRENT_PRICING = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-profiles-"));
  configPath = join(home, "subscriptions.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      subscriptions: [
        {
          id: "claude",
          planId: "claude-pro",
          label: "Mine",
          match: [{ provider: "claude-bridge" }],
        },
      ],
    }),
  );
  await db.run(
    `INSERT INTO ingest_checkpoints VALUES ('src', 'content', '1', '2026-10-10T12:00:00Z', $1),
      ('old', 'content', '1', '2026-10-10T12:00:00Z', 'stale')`,
    [CURRENT_PRICING],
  );
  await db.run(
    `INSERT INTO profiles VALUES
      ('h1', 'alpha', '{}', '2026-01-01T00:00:00Z'),
      ('h2', 'alpha', '{}', '2026-01-05T00:00:00Z'),
      ('h3', 'beta', '{}', '2026-01-01T00:00:00Z')`,
  );
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, started_at, format_version, parent_session_id) VALUES
      ('P', 'src', 'gentle-shell', '2026-10-10T09:00:00Z', '3', NULL),
      ('C', 'src', 'gentle-shell', '2026-10-10T09:10:00Z', 'pi-subagent/3', 'P'),
      ('Q', 'old', 'gentle-shell', '2026-10-10T10:00:00Z', '3', NULL),
      ('X', 'src', 'gentle-shell', '2026-10-10T11:00:00Z', '3', NULL),
      ('O', 'src', 'claude-code', '2026-10-10T11:00:00Z', '1', NULL)`,
  );
  await db.run(
    `INSERT INTO subagent_runs (id, parent_session_id, role, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens) VALUES ('C', 'P', 'gentle-ai-worker', 0, 0, 0, 0)`,
  );
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, provider, model, effort, is_compaction) VALUES
      ('p1', 'P', 0, 'assistant', '2026-10-10T09:01:00Z', 'claude-bridge', 'opus', 'high', false),
      ('p2', 'P', 1, 'assistant', '2026-10-10T09:02:00Z', 'claude-bridge', 'opus', 'low', false),
      ('pu', 'P', 2, 'user', '2026-10-10T09:03:00Z', 'claude-bridge', 'opus', 'low', false),
      ('c1', 'C', 0, 'assistant', '2026-10-10T09:11:00Z', 'opencode-go', 'glm', 'high', false),
      ('q1', 'Q', 0, 'assistant', '2026-10-10T10:01:00Z', 'opencode-go', 'glm', 'medium', false),
      ('x1', 'X', 0, 'assistant', '2026-10-10T11:01:00Z', 'anthropic', 'x', NULL, false),
      ('o1', 'O', 0, 'assistant', '2026-10-10T11:01:00Z', 'anthropic', 'x', NULL, false),
      ('late', 'P', 3, 'assistant', '2026-10-12T00:00:00Z', 'claude-bridge', 'opus', 'high', false)`,
  );
  await db.run(
    `INSERT INTO usage (turn_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reported_cost_usd, computed_cost_usd) VALUES
      ('p1', 100, 10, 0, 0, 1, 2),
      ('p2', 50, 0, 0, 0, NULL, 1),
      ('c1', 30, 0, 0, 0, 0.5, NULL),
      ('q1', 20, 0, 0, 0, NULL, 0.2),
      ('x1', 7, 0, 0, 0, NULL, NULL),
      ('o1', 9, 0, 0, 0, NULL, NULL),
      ('late', 1000, 0, 0, 0, 10, 10)`,
  );
  await db.run(
    `INSERT INTO turn_profile VALUES
      ('p1', 'h1', 'exact'), ('pu', 'h1', 'exact'), ('p2', 'h2', 'estimated'),
      ('c1', 'h1', 'exact'), ('q1', 'h3', 'estimated'), ('late', 'h1', 'exact')`,
  );
});
afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const app = () => createApp(db, { subscriptions: { configPath } });
const get = (query = PERIOD) => app().request(`/api/profiles?${query}`);

function figures(input: {
  turns: number;
  sessions?: number;
  tokens: number;
  computed?: number | null;
  reported?: number | null;
  exact?: [number, number];
  estimated?: [number, number];
}): ProfileFigures {
  const [exactTurns, exactTokens] = input.exact ?? [0, 0];
  const [estimatedTurns, estimatedTokens] = input.estimated ?? [0, 0];
  return {
    turns: input.turns,
    sessions: input.sessions ?? 1,
    input: input.tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: input.tokens,
    computedCost: input.computed ?? null,
    reportedCost: input.reported ?? null,
    exactTurns,
    estimatedTurns,
    exactShare: input.tokens ? exactTokens / input.tokens : null,
    estimatedShare: input.tokens ? estimatedTokens / input.tokens : null,
  };
}

describe("GET /api/profiles (S7, S8, L10)", () => {
  it("reports totals, sessions, roles, efforts and subscriptions with exact vs estimated shares", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as ProfilesResponse;
    const p1 = {
      ...figures({ turns: 1, tokens: 100, computed: 2, reported: 1 }),
      output: 10,
      total: 110,
    };
    const alphaTotals = {
      ...figures({
        turns: 4,
        tokens: 180,
        computed: 3,
        reported: 1.5,
        exact: [3, 140],
        estimated: [1, 50],
      }),
      output: 10,
      total: 190,
      exactShare: 140 / 190,
      estimatedShare: 50 / 190,
    };
    const orchestrator = {
      ...figures({
        turns: 3,
        tokens: 150,
        computed: 3,
        reported: 1,
        exact: [2, 110],
        estimated: [1, 50],
      }),
      output: 10,
      total: 160,
      exactShare: 110 / 160,
      estimatedShare: 50 / 160,
    };
    expect(body).toEqual({
      period: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-11T00:00:00.000Z" },
      profiles: [
        {
          name: "alpha",
          versions: [
            { hash: "h1", firstSeenAt: "2026-01-01T00:00:00.000Z" },
            { hash: "h2", firstSeenAt: "2026-01-05T00:00:00.000Z" },
          ],
          totals: alphaTotals,
          sessions: [
            {
              sessionId: "P",
              agent: "gentle-shell",
              startedAt: "2026-10-10T09:00:00.000Z",
              ...alphaTotals,
            },
          ],
          roles: [
            {
              role: "gentle-ai-worker",
              ...figures({ turns: 1, tokens: 30, reported: 0.5, exact: [1, 30] }),
            },
            { role: "orchestrator", ...orchestrator },
          ],
          efforts: [
            {
              provider: "claude-bridge",
              model: "opus",
              effort: "high",
              ...p1,
              exactTurns: 1,
              exactShare: 1,
              estimatedShare: 0,
            },
            {
              provider: "claude-bridge",
              model: "opus",
              effort: "low",
              ...figures({ turns: 2, tokens: 50, computed: 1, exact: [1, 0], estimated: [1, 50] }),
            },
            {
              provider: "opencode-go",
              model: "glm",
              effort: "high",
              ...figures({ turns: 1, tokens: 30, reported: 0.5, exact: [1, 30] }),
            },
          ],
          subscriptions: [
            { subscriptionId: "claude", label: "Mine", ...orchestrator },
            {
              subscriptionId: null,
              label: null,
              ...figures({ turns: 1, tokens: 30, reported: 0.5, exact: [1, 30] }),
            },
          ],
        },
        {
          name: "beta",
          versions: [{ hash: "h3", firstSeenAt: "2026-01-01T00:00:00.000Z" }],
          // Q was priced with another catalog: its computed cost is stale, so unknown.
          totals: figures({ turns: 1, tokens: 20, estimated: [1, 20] }),
          sessions: [
            {
              sessionId: "Q",
              agent: "gentle-shell",
              startedAt: "2026-10-10T10:00:00.000Z",
              ...figures({ turns: 1, tokens: 20, estimated: [1, 20] }),
            },
          ],
          roles: [
            { role: "orchestrator", ...figures({ turns: 1, tokens: 20, estimated: [1, 20] }) },
          ],
          efforts: [
            {
              provider: "opencode-go",
              model: "glm",
              effort: "medium",
              ...figures({ turns: 1, tokens: 20, estimated: [1, 20] }),
            },
          ],
          subscriptions: [
            {
              subscriptionId: null,
              label: null,
              ...figures({ turns: 1, tokens: 20, estimated: [1, 20] }),
            },
          ],
        },
      ],
      // Only gentle-shell turns can be unattributed; the Claude Code turn is out of scope.
      unattributed: figures({ turns: 1, tokens: 7 }),
    } satisfies ProfilesResponse);
  });

  it("answers an empty report when nothing is attributed in the period", async () => {
    const response = await get("from=2027-01-01T00:00:00.000Z&to=2027-01-02T00:00:00.000Z");
    expect(response.status).toBe(200);
    expect(((await response.json()) as ProfilesResponse).profiles).toEqual([]);
  });

  it("keeps the last synced subscriptions when the config is invalid", async () => {
    expect((await get()).status).toBe(200);
    writeFileSync(configPath, "{ PRIVATE_SENTINEL");
    const body = (await (await get()).json()) as ProfilesResponse;
    expect(body.profiles[0]?.subscriptions.map((s) => s.subscriptionId)).toEqual(["claude", null]);
  });

  it.each([
    "from=2026-10-01",
    "from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z",
    "from=x&to=y",
  ])("rejects an invalid period %s", async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid profiles period" });
  });

  it("fails closed on corrupt stored figures", async () => {
    await db.run("UPDATE usage SET reported_cost_usd = 'NaN'::DOUBLE WHERE turn_id = 'p1'");
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "profiles unavailable" });
  });
});
