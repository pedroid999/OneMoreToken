import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  migrate,
  openDatabase,
  type ProfileSnapshot,
  parseProfilesFile,
  profileSnapshot,
  readProfilesFile,
  recomputeProfileAttribution,
  TURN_ROLE_SQL,
  upsertProfiles,
} from "../src/index";

const SEEN = "2026-01-01T00:00:00.000Z";

const snapshot = (name: string, roles: unknown, seenAt = SEEN): ProfileSnapshot => {
  const result = profileSnapshot(name, roles, seenAt);
  if (!result) throw new Error("Expected a snapshot");
  return result;
};

describe("profile snapshots (S6, S8, L10)", () => {
  it("hashes the canonical definition: key order is irrelevant, a role model change is not", () => {
    const a = snapshot("alpha", {
      orchestrator: { model: "a/x", thinking: "high" },
      worker: { thinking: "low", model: "b/y" },
    });
    const b = snapshot("alpha", {
      worker: { model: "b/y", thinking: "low" },
      orchestrator: { thinking: "high", model: "a/x" },
    });
    expect(a.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(b.hash).toBe(a.hash);
    expect(b.definition).toEqual(a.definition);
    const changed = snapshot("alpha", {
      orchestrator: { model: "a/x", thinking: "high" },
      worker: { model: "b/z", thinking: "low" },
    });
    expect(changed.hash).not.toBe(a.hash);
    expect(snapshot("beta", a.definition.roles).hash).not.toBe(a.hash);
  });

  it("keeps only profiles.<name>.<role>.{model, thinking|effort}", () => {
    const snapshots = parseProfilesFile(
      {
        kind: "gentle-pi.agent_model_profiles",
        version: 1,
        active: "PRIVATE_SENTINEL",
        secret: "PRIVATE_SENTINEL",
        profiles: {
          alpha: {
            orchestrator: { model: "a/x", thinking: "high", apiKey: "PRIVATE_SENTINEL" },
            explore: "a/y",
            legacy: { model: "a/z", effort: "low" },
            empty: { note: "PRIVATE_SENTINEL" },
          },
          broken: "PRIVATE_SENTINEL",
        },
      },
      SEEN,
    );
    expect(snapshots).toEqual([
      {
        hash: snapshot("alpha", {
          orchestrator: { model: "a/x", thinking: "high" },
          explore: { model: "a/y" },
          legacy: { model: "a/z", thinking: "low" },
        }).hash,
        name: "alpha",
        definition: {
          name: "alpha",
          roles: {
            explore: { model: "a/y" },
            legacy: { model: "a/z", thinking: "low" },
            orchestrator: { model: "a/x", thinking: "high" },
          },
        },
        first_seen_at: SEEN,
      },
    ]);
    expect(JSON.stringify(snapshots)).not.toContain("PRIVATE_SENTINEL");
    expect(parseProfilesFile("PRIVATE_SENTINEL", SEEN)).toBeNull();
    expect(parseProfilesFile({ kind: "other", profiles: {} }, SEEN)).toBeNull();
  });

  describe("profiles.json file", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "omt-profiles-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("reads it read-only: missing means none, invalid is reported without snapshots", () => {
      const path = join(dir, "profiles.json");
      expect(readProfilesFile(path, SEEN)).toEqual({ status: "missing", snapshots: [] });
      writeFileSync(path, "{ PRIVATE_SENTINEL");
      expect(readProfilesFile(path, SEEN)).toEqual({ status: "invalid", snapshots: [] });
      writeFileSync(path, JSON.stringify({ profiles: { alpha: { orchestrator: "a/x" } } }));
      expect(readProfilesFile(path, SEEN)).toEqual({
        status: "ok",
        snapshots: [snapshot("alpha", { orchestrator: "a/x" })],
      });
    });
  });
});

describe("profile attribution (S7, S8, L10, L12)", () => {
  let db: Database;
  const alphaV1 = snapshot(
    "alpha",
    { orchestrator: { model: "a/x", thinking: "high" }, worker: { model: "b/y", thinking: "low" } },
    "2026-01-01T00:00:00.000Z",
  );
  const alphaV2 = snapshot(
    "alpha",
    { orchestrator: { model: "a/x", thinking: "high" }, worker: { model: "b/z", thinking: "low" } },
    "2026-01-05T00:00:00.000Z",
  );
  const beta = snapshot(
    "beta",
    {
      orchestrator: { model: "c/w", thinking: "medium" },
      worker: { model: "b/y", thinking: "low" },
    },
    "2026-01-01T00:00:00.000Z",
  );

  const session = (
    id: string,
    started: string,
    options: { agent?: string; parent?: string; format?: string } = {},
  ) =>
    db.run(
      `INSERT INTO sessions (id, source_id, agent, started_at, format_version, parent_session_id)
       VALUES ($1, 'src', $2, $3, $4, $5)`,
      [id, options.agent ?? "gentle-shell", started, options.format ?? "3", options.parent ?? null],
    );
  let idx = 0;
  const turn = (id: string, sessionId: string, ts: string, route: string | null, effort = "high") =>
    db.run(
      `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, effort, is_compaction)
       VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, false)`,
      [
        id,
        sessionId,
        idx++,
        ts,
        route?.split("/")[1] ?? null,
        route?.split("/")[0] ?? null,
        effort,
      ],
    );
  const run = (child: string, parent: string, role: string) =>
    db.run(
      `INSERT INTO subagent_runs (id, parent_session_id, role, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens) VALUES ($1, $2, $3, 0, 0, 0, 0)`,
      [child, parent, role],
    );
  const bind = (turnId: string, hash: string) =>
    db.run("INSERT INTO turn_profile_bindings VALUES ($1, $2)", [turnId, hash]);
  const attributed = async () =>
    Object.fromEntries(
      (
        await db.all<{ turn_id: string; profile_hash: string; attribution: string }>(
          "SELECT turn_id, profile_hash, attribution FROM turn_profile ORDER BY turn_id",
        )
      ).map((row) => [row.turn_id, [nameOf(row.profile_hash), row.attribution]]),
    );
  const nameOf = (hash: string) =>
    ({ [alphaV1.hash]: "alpha@1", [alphaV2.hash]: "alpha@2", [beta.hash]: "beta" })[hash] ?? hash;

  beforeEach(async () => {
    db = await openDatabase(":memory:");
    await migrate(db);
    await upsertProfiles(db, [alphaV1, alphaV2, beta]);
    idx = 0;
  });
  afterEach(() => db.close());

  it("attributes exactly from a bind until it is cleared, and child sessions inherit it", async () => {
    await session("parent", "2026-01-03T00:00:00Z");
    await turn("p1", "parent", "2026-01-03T00:00:01Z", "z/none");
    await turn("p2", "parent", "2026-01-03T00:00:02Z", "z/none");
    await turn("p3", "parent", "2026-01-03T00:00:10Z", "z/none");
    await bind("p1", beta.hash);
    await bind("p2", beta.hash);
    // p3 follows a clear: no binding row.
    await session("child-bound", "2026-01-03T00:00:05Z", { parent: "parent" });
    await run("child-bound", "parent", "worker");
    await turn("c1", "child-bound", "2026-01-03T00:00:06Z", "z/none");
    await session("child-after", "2026-01-03T00:00:11Z", { parent: "parent" });
    await run("child-after", "parent", "worker");
    await turn("c2", "child-after", "2026-01-03T00:00:12Z", "z/none");
    // A bound non-gentle session is still exact.
    await session("pi", "2026-01-03T00:00:00Z", { agent: "pi" });
    await turn("pi1", "pi", "2026-01-03T00:00:01Z", "z/none");
    await bind("pi1", alphaV1.hash);

    expect(await recomputeProfileAttribution(db)).toEqual({ exact: 4, estimated: 0 });
    expect(await attributed()).toEqual({
      p1: ["beta", "exact"],
      p2: ["beta", "exact"],
      c1: ["beta", "exact"],
      pi1: ["alpha@1", "exact"],
    });
  });

  it("estimates a unique role match and leaves ambiguous or unknown roles unattributed", async () => {
    await session("parent", "2026-01-03T00:00:00Z");
    await turn("orchestrator", "parent", "2026-01-03T00:00:01Z", "a/x", "high");
    await turn("wrong-effort", "parent", "2026-01-03T00:00:02Z", "a/x", "low");
    await session("worker", "2026-01-03T00:00:03Z", { parent: "parent" });
    await run("worker", "parent", "worker");
    // b/y + low is the worker route of both alpha@1 and beta: ambiguous.
    await turn("ambiguous", "worker", "2026-01-03T00:00:04Z", "b/y", "low");
    await turn("worker-z", "worker", "2026-01-06T00:00:00Z", "b/z", "low");
    // A child without a run is role unknown, never orchestrator, even on an orchestrator route.
    await session("orphan", "2026-01-03T00:00:00Z", { format: "pi-subagent/3" });
    await turn("unknown", "orphan", "2026-01-03T00:00:01Z", "a/x", "high");
    // Estimation is gentle-shell only.
    await session("claude", "2026-01-03T00:00:00Z", { agent: "claude-code" });
    await turn("other-agent", "claude", "2026-01-03T00:00:01Z", "a/x", "high");

    expect(await recomputeProfileAttribution(db)).toEqual({ exact: 0, estimated: 2 });
    expect(await attributed()).toEqual({
      orchestrator: ["alpha@1", "estimated"],
      "worker-z": ["alpha@2", "estimated"],
    });
    const roles = await db.all(
      `SELECT s.id, ${TURN_ROLE_SQL} AS role FROM sessions s
       LEFT JOIN subagent_runs r ON r.id = s.id ORDER BY s.id`,
    );
    expect(roles).toEqual([
      { id: "claude", role: null },
      { id: "orphan", role: "unknown" },
      { id: "parent", role: "orchestrator" },
      { id: "worker", role: "worker" },
    ]);
  });

  it("picks the version in force by first_seen_at, else the earliest", async () => {
    await session("parent", "2025-12-30T00:00:00Z");
    await turn("before", "parent", "2025-12-30T00:00:00Z", "a/x");
    await turn("v1", "parent", "2026-01-03T00:00:00Z", "a/x");
    await turn("v2", "parent", "2026-01-06T00:00:00Z", "a/x");
    await recomputeProfileAttribution(db);
    expect(await attributed()).toEqual({
      before: ["alpha@1", "estimated"],
      v1: ["alpha@1", "estimated"],
      v2: ["alpha@2", "estimated"],
    });
  });

  it("matches any effort when the role entry sets none", async () => {
    await upsertProfiles(db, [snapshot("gamma", { orchestrator: { model: "g/m" } })]);
    await session("parent", "2026-01-03T00:00:00Z");
    await turn("any", "parent", "2026-01-03T00:00:01Z", "g/m", "xhigh");
    await recomputeProfileAttribution(db);
    expect(Object.keys(await attributed())).toEqual(["any"]);
  });

  it("recomputes in full and is idempotent", async () => {
    await session("parent", "2026-01-03T00:00:00Z");
    await turn("orchestrator", "parent", "2026-01-03T00:00:01Z", "a/x");
    await db.run("INSERT INTO turn_profile VALUES ('gone', 'stale', 'exact')");
    await recomputeProfileAttribution(db);
    const first = await attributed();
    expect(await recomputeProfileAttribution(db)).toEqual({ exact: 0, estimated: 1 });
    expect(await attributed()).toEqual(first);
    expect(first).toEqual({ orchestrator: ["alpha@1", "estimated"] });
  });

  it("keeps the earliest first_seen_at when a snapshot is seen again", async () => {
    await upsertProfiles(db, [{ ...alphaV1, first_seen_at: "2025-06-01T00:00:00.000Z" }]);
    await upsertProfiles(db, [{ ...alphaV1, first_seen_at: "2027-01-01T00:00:00.000Z" }]);
    const rows = await db.all<{ first_seen_at: string; definition: string }>(
      `SELECT strftime(first_seen_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS first_seen_at,
        CAST(definition AS VARCHAR) AS definition FROM profiles WHERE hash = $1`,
      [alphaV1.hash],
    );
    expect(rows).toEqual([
      { first_seen_at: "2025-06-01T00:00:00.000Z", definition: JSON.stringify(alphaV1.definition) },
    ]);
  });
});
