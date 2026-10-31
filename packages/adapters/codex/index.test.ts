import { readFileSync } from "node:fs";
import { createSource, type ParseContext, recordId, sourceFileId } from "@omt/core";
import { describe, expect, it } from "vitest";
import {
  CODEX_ADAPTER_VERSION,
  codexSessionMeta,
  createCodexDocument,
  parseCodex,
  readCodexQuotaReadings,
} from "./index";

const context: ParseContext = {
  agent: "codex",
  path: "/synthetic/sessions/2026/10/20/rollout-2026-10-20T09-00-00-thread-main.jsonl",
  adapterVersion: CODEX_ADAPTER_VERSION,
  ingestedAt: "2026-10-21T00:00:00.000Z",
  pricing: {
    version: 1,
    currency: "USD",
    entries: [
      {
        provider: "openai",
        model: "fixture-model",
        validFrom: "2026-01-01",
        validTo: null,
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 0.5,
        cacheWritePerMTok: 1,
      },
    ],
  },
};
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const source = createSource(context);
const session = recordId(source.id, "session", "thread-main");

describe("parseCodex", () => {
  it("normalizes a rollout into metrics-only sessions, turns, usage and tools", () => {
    expect(parseCodex(fixture("rollout.jsonl"), context)).toMatchSnapshot();
  });

  it("never stores prompts, tool input/output, reasoning or instructions", () => {
    const serialized = JSON.stringify(parseCodex(fixture("rollout.jsonl"), context));
    for (const secret of ["PRIVATE", "SECRET", "example.invalid"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("splits cached input out of input tokens and prices it per turn", () => {
    const batch = parseCodex(fixture("rollout.jsonl"), context);
    const first = batch.usage.find((row) => row.turn_id === recordId(source.id, "turn", "resp-1"));
    expect(first).toMatchObject({
      input_tokens: 600,
      cache_read_tokens: 400,
      cache_write_tokens: 0,
      output_tokens: 50,
    });
    // 600 * 1 + 400 * 0.5 + 50 * 2 per million tokens.
    expect(first?.computed_cost_usd).toBeCloseTo(0.0009, 10);
    const unpriced = batch.usage.find(
      (row) => row.turn_id === recordId(source.id, "turn", "resp-4"),
    );
    expect(unpriced).toMatchObject({ input_tokens: 300, cache_write_tokens: 20 });
    expect(unpriced?.computed_cost_usd).toBeNull();
  });

  it("attributes model and effort from the turn context and tools to the producing response", () => {
    const batch = parseCodex(fixture("rollout.jsonl"), context);
    const assistant = batch.turns.filter((turn) => turn.role === "assistant");
    expect(assistant.map((turn) => [turn.model, turn.effort, turn.provider])).toEqual([
      ["fixture-model", "medium", "openai"],
      ["fixture-model", "medium", "openai"],
      ["unpriced-model", "high", "openai"],
    ]);
    expect(batch.turns.filter((turn) => turn.role === "user")).toHaveLength(2);
    expect(batch.toolCalls.map((tool) => [tool.tool, tool.turn_id, tool.duration_ms])).toEqual([
      ["exec", recordId(source.id, "turn", "resp-1"), 2000],
      ["spawn_agent", recordId(source.id, "turn", "resp-2"), 1000],
    ]);
    expect(batch.sessions).toEqual([
      expect.objectContaining({
        id: session,
        cwd: "/synthetic/repo",
        branch: "main",
        repo: null,
        started_at: "2026-10-20T09:00:00.000Z",
        ended_at: "2026-10-20T10:00:04.000Z",
        format_version: "codex-rollout/1",
        parent_session_id: null,
      }),
    ]);
  });

  it("records corrupt lines and invalid usage as issues without stopping", () => {
    const batch = parseCodex(fixture("rollout.jsonl"), context);
    expect(batch.issues.map((issue) => [issue.code, issue.location])).toEqual([
      ["invalid_json", "12"],
      ["invalid_record", "17"],
    ]);
    expect(batch.usage).toHaveLength(3);
  });

  it("is idempotent: the same content yields the same rows", () => {
    expect(parseCodex(fixture("rollout.jsonl"), context)).toEqual(
      parseCodex(fixture("rollout.jsonl"), context),
    );
  });

  it("keeps a legacy rollout as a usage-free session with its own format version", () => {
    const legacyContext = { ...context, path: "/synthetic/sessions/2025/09/10/legacy.jsonl" };
    const batch = parseCodex(fixture("legacy.jsonl"), legacyContext);
    expect(batch.sessions).toEqual([
      expect.objectContaining({
        started_at: "2025-09-10T14:37:39.000Z",
        format_version: "codex-legacy/1",
      }),
    ]);
    expect(batch.turns).toEqual([]);
    expect(batch.usage).toEqual([]);
    expect(batch.issues.map((issue) => issue.code)).toEqual(["missing_usage"]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE");
  });

  it("rejects content without session metadata as an unsupported format", () => {
    const batch = parseCodex('{"type":"event_msg","payload":{}}\n', context);
    expect(batch.sessions).toEqual([]);
    expect(batch.issues.map((issue) => issue.code)).toEqual(["unsupported_format"]);
  });

  it("links a subagent thread to its parent and records one run", () => {
    const parentPath = context.path;
    const childContext = {
      ...context,
      path: "/synthetic/sessions/2026/10/20/rollout-2026-10-20T09-00-08-thread-child.jsonl",
    };
    const document = createCodexDocument({
      rollout: fixture("subagent.jsonl"),
      parentPath,
    });
    const batch = parseCodex(document, childContext);
    const parent = recordId(sourceFileId("codex", parentPath), "session", "thread-main");
    const child = recordId(createSource(childContext).id, "session", "thread-child");
    expect(batch.sessions[0]).toMatchObject({ id: child, parent_session_id: parent });
    expect(batch.subagentRuns).toEqual([
      {
        id: child,
        parent_session_id: parent,
        role: "explorer",
        model: "fixture-model",
        provider: "openai",
        effort: "high",
        started_at: "2026-10-20T09:00:08.500Z",
        duration_ms: 400,
        input_tokens: 500,
        output_tokens: 20,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reported_cost_usd: null,
        computed_cost_usd: 0.00054,
      },
    ]);
    expect(JSON.stringify(batch)).not.toContain("Synthetic");
  });

  it("keeps a subagent without a resolvable parent as a plain session", () => {
    const batch = parseCodex(fixture("subagent.jsonl"), context);
    expect(batch.sessions[0]?.parent_session_id).toBeNull();
    expect(batch.subagentRuns ?? []).toEqual([]);
  });
});

describe("codexSessionMeta", () => {
  it("reads the thread id and parent thread id from the first record", () => {
    expect(codexSessionMeta(fixture("rollout.jsonl"))).toEqual({
      id: "thread-main",
      parentId: null,
    });
    expect(codexSessionMeta(fixture("subagent.jsonl"))).toEqual({
      id: "thread-child",
      parentId: "thread-main",
    });
    expect(codexSessionMeta("not json")).toBeNull();
  });
});

describe("readCodexQuotaReadings", () => {
  it("maps rate limits to 5 h and weekly readings", () => {
    expect(readCodexQuotaReadings(fixture("rollout.jsonl"))).toEqual([
      {
        observedAt: "2026-10-20T09:00:05.200Z",
        windowKind: "five_hours",
        observedPct: 12,
        resetsAt: "2026-10-20T14:00:00.000Z",
      },
      {
        observedAt: "2026-10-20T09:00:05.200Z",
        windowKind: "weekly",
        observedPct: 4,
        resetsAt: "2026-10-26T07:33:20.000Z",
      },
    ]);
  });

  it("skips unknown windows, invalid percentages and null rate limits", () => {
    const lines = [
      {
        timestamp: "2026-10-20T09:00:00.000Z",
        type: "event_msg",
        payload: { type: "token_count", rate_limits: null },
      },
      {
        timestamp: "2026-10-20T09:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 140, window_minutes: 300, resets_at: 1792504800 },
            secondary: { used_percent: 5, window_minutes: 60, resets_at: 1792504800 },
          },
        },
      },
    ];
    expect(readCodexQuotaReadings(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual(
      [],
    );
  });
});
