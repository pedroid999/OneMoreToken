import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSubscriptions } from "../src/data/files";
import { type Database, openDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";
import {
  loadUserSubscriptions,
  syncUserSubscriptions,
  type UserSubscriptionsFile,
} from "../src/subscriptions/config";

const plans = loadSubscriptions();

const scratch: string[] = [];
function tempFile(content: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "omt-subs-"));
  scratch.push(dir);
  const path = join(dir, "subscriptions.json");
  if (content !== null) writeFileSync(path, content);
  return path;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const claudePro = {
  id: "claude",
  planId: "claude-pro",
  startedAt: "2026-10-01",
  match: [{ provider: "claude-bridge" }],
};

describe("loadUserSubscriptions", () => {
  it("returns no subscriptions when the local file does not exist", () => {
    expect(loadUserSubscriptions(tempFile(null), plans)).toEqual({
      ok: true,
      file: { version: 1, subscriptions: [] },
    });
  });

  it("loads a valid file", () => {
    const file = { version: 1, subscriptions: [claudePro] };
    expect(loadUserSubscriptions(tempFile(JSON.stringify(file)), plans)).toEqual({
      ok: true,
      file,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "an unknown plan",
      JSON.stringify({ version: 1, subscriptions: [{ ...claudePro, planId: "nope" }] }),
    ],
    ["duplicated ids", JSON.stringify({ version: 1, subscriptions: [claudePro, claudePro] })],
    [
      "endedAt before startedAt",
      JSON.stringify({ version: 1, subscriptions: [{ ...claudePro, endedAt: "2026-09-01" }] }),
    ],
    [
      "no match rules",
      JSON.stringify({ version: 1, subscriptions: [{ ...claudePro, match: [] }] }),
    ],
  ])("rejects %s with a fixed error", (_name, content) => {
    const result = loadUserSubscriptions(tempFile(content), plans);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("invalid subscriptions config");
  });
});

async function seeded(): Promise<Database> {
  const db = await openDatabase(":memory:");
  await migrate(db);
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, started_at, format_version) VALUES
      ('s-pi', 'src', 'gentle-shell', '2026-10-10T10:00:00Z', '3'),
      ('s-oc', 'src', 'opencode', '2026-10-10T10:00:00Z', '1')`,
  );
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, provider) VALUES
      ('before', 's-pi', 0, 'assistant', '2026-09-30T12:00:00Z', 'claude-bridge'),
      ('claude', 's-pi', 1, 'assistant', '2026-10-10T12:00:00Z', 'claude-bridge'),
      ('go-pi', 's-pi', 2, 'assistant', '2026-10-10T13:00:00Z', 'opencode-go'),
      ('go-oc', 's-oc', 0, 'assistant', '2026-10-10T13:00:00Z', 'opencode-go'),
      ('api', 's-pi', 3, 'assistant', '2026-10-10T14:00:00Z', 'anthropic')`,
  );
  return db;
}

async function attribution(db: Database): Promise<Record<string, string | null>> {
  const rows = await db.all<{ turn_id: string; subscription_id: string | null }>(
    "SELECT turn_id, subscription_id FROM turn_subscriptions ORDER BY turn_id",
  );
  return Object.fromEntries(rows.map((r) => [r.turn_id, r.subscription_id]));
}

describe("syncUserSubscriptions + turn_subscriptions", () => {
  it("attributes turns by provider inside the date range, many agents to one subscription", async () => {
    const db = await seeded();
    const file: UserSubscriptionsFile = {
      version: 1,
      subscriptions: [
        claudePro,
        {
          id: "go",
          planId: "opencode-go",
          startedAt: "2026-10-01",
          match: [{ provider: "opencode-go" }],
        },
      ],
    };
    await syncUserSubscriptions(db, file, plans);

    expect(await attribution(db)).toEqual({
      api: null,
      before: null,
      claude: "claude",
      "go-oc": "go",
      "go-pi": "go",
    });
    expect(
      await db.all(
        "SELECT id, plan_id, provider, label, CAST(started_at AS VARCHAR) AS started_at, ended_at FROM subscriptions ORDER BY id",
      ),
    ).toEqual([
      {
        id: "claude",
        plan_id: "claude-pro",
        provider: "anthropic",
        label: "Claude Pro",
        started_at: "2026-10-01",
        ended_at: null,
      },
      {
        id: "go",
        plan_id: "opencode-go",
        provider: "opencode",
        label: "OpenCode Go",
        started_at: "2026-10-01",
        ended_at: null,
      },
    ]);
    db.close();
  });

  it("honours an agent-specific rule and the first matching subscription in file order", async () => {
    const db = await seeded();
    await syncUserSubscriptions(
      db,
      {
        version: 1,
        subscriptions: [
          {
            id: "go-oc",
            planId: "opencode-go",
            label: "Go (OpenCode)",
            match: [{ provider: "opencode-go", agent: "opencode" }],
          },
          { id: "go-any", planId: "opencode-go", match: [{ provider: "opencode-go" }] },
        ],
      },
      plans,
    );
    const result = await attribution(db);
    expect(result["go-oc"]).toBe("go-oc");
    expect(result["go-pi"]).toBe("go-any");
    db.close();
  });

  it("replaces the previous configuration on every sync", async () => {
    const db = await seeded();
    await syncUserSubscriptions(db, { version: 1, subscriptions: [claudePro] }, plans);
    await syncUserSubscriptions(db, { version: 1, subscriptions: [] }, plans);
    expect(Object.values(await attribution(db)).every((value) => value === null)).toBe(true);
    expect(await db.all("SELECT * FROM subscriptions")).toEqual([]);
    expect(await db.all("SELECT * FROM subscription_rules")).toEqual([]);
    db.close();
  });
});
