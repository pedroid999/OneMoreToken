import { readFileSync } from "node:fs";
import {
  createIssue,
  createSource,
  NormalizedBatchSchema,
  type ParseContext,
  recordId,
} from "@omt/core";
import { describe, expect, it } from "vitest";
import { CLAUDE_CODE_ADAPTER_VERSION, parseClaudeCode } from "./index";

const context: ParseContext = {
  agent: "claude-code",
  path: "/synthetic/session.jsonl",
  adapterVersion: "claude-code-jsonl-v1",
  ingestedAt: "2026-10-17T00:00:00.000Z",
  pricing: {
    version: 1,
    currency: "USD",
    entries: [
      {
        provider: "anthropic",
        model: "fixture-model",
        validFrom: "2026-01-01",
        validTo: null,
        inputPerMTok: 1,
        outputPerMTok: 2,
        cacheReadPerMTok: 3,
        cacheWritePerMTok: 4,
      },
    ],
  },
};
const fixture = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");
const row = (overrides: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid: "a",
  sessionId: "s",
  timestamp: "2026-10-16T10:00:00.000Z",
  message: { id: "m", model: "fixture-model", usage: { input_tokens: 1, output_tokens: 2 } },
  ...overrides,
});
const jsonl = (...rows: unknown[]) => `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`;

describe("Claude Code metrics-only JSONL", () => {
  it("snapshots reconstructed observed shapes without charging repeated blocks or cost-state", () => {
    expect(CLAUDE_CODE_ADAPTER_VERSION).toBe(context.adapterVersion);
    const batch = parseClaudeCode(fixture, context);
    expect(NormalizedBatchSchema.parse(batch)).toEqual(batch);
    expect(batch).toMatchSnapshot();
    expect(batch.usage).toHaveLength(2);
    expect(batch.usage[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 12,
      cache_read_tokens: 40,
      cache_write_tokens: 30,
      reported_cost_usd: null,
      computed_cost_usd: 0.000364,
    });
    expect(batch.usage[1]).toMatchObject({ computed_cost_usd: null, cache_write_tokens: 5 });
    expect(
      batch.toolCalls.map(({ tool, status, duration_ms }) => ({ tool, status, duration_ms })),
    ).toEqual([
      { tool: "Read", status: "ok", duration_ms: 2000 },
      { tool: "Bash", status: "error", duration_ms: 2000 },
    ]);
    expect(JSON.stringify(batch)).not.toContain("SYNTHETIC_PRIVATE");
    expect(batch.issues).toEqual([
      createIssue(batch.source, "invalid_json", "9", context.ingestedAt),
    ]);
  });

  it.each([
    { timestamp: "bad" },
    { timestamp: "2026-02-30T00:00:00Z" },
    { message: { id: "bad", usage: { input_tokens: -1, output_tokens: 2 } } },
    { message: { id: "bad", usage: { input_tokens: "secret", output_tokens: 2 } } },
    { message: { id: "bad", usage: { input_tokens: 1, output_tokens: null } } },
    { message: { id: "bad", usage: { input_tokens: 1.5, output_tokens: 2 } } },
    {
      message: {
        id: "bad",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_creation: { ephemeral_1h_input_tokens: -1 },
        },
      },
    },
    {
      message: {
        id: "bad",
        content: [{ type: "tool_use", id: "t" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
  ])("isolates invalid row %j and retains valid preceding/following metrics", (bad) => {
    const valid = [
      row(),
      row({
        uuid: "a2",
        message: {
          id: "m2",
          usage: {
            input_tokens: 2,
            output_tokens: 3,
          },
        },
      }),
    ];
    const expected = parseClaudeCode(jsonl(...valid), context);
    const actual = parseClaudeCode(jsonl(valid[0], row(bad), valid[1]), context);
    expect({ ...actual, issues: [] }).toEqual(expected);
    expect(actual.issues).toEqual([
      createIssue(actual.source, "invalid_record", "2", context.ingestedAt),
    ]);
  });

  it("retains final counters and pricing when repeated blocks omit model metadata", () => {
    const repeated = row({ message: { id: "m", usage: { input_tokens: 1, output_tokens: 4 } } });
    const batch = parseClaudeCode(jsonl(row(), repeated, row()), context);
    expect(batch.turns).toHaveLength(1);
    expect(batch.usage).toEqual([
      {
        turn_id: batch.turns[0]?.id,
        input_tokens: 1,
        output_tokens: 4,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reported_cost_usd: null,
        computed_cost_usd: 0.000009,
      },
    ]);
  });

  it("prices existing metrics when a later block supplies the missing model", () => {
    const first = row({ message: { id: "m", usage: { input_tokens: 1, output_tokens: 2 } } });
    const final = row({ message: { id: "m", model: "fixture-model" } });
    const batch = parseClaudeCode(jsonl(first, final), context);
    expect(batch.turns).toHaveLength(1);
    expect(batch.usage).toEqual(parseClaudeCode(jsonl(row()), context).usage);
    expect(batch.issues).toEqual([]);
  });

  it("rejects nonfinite JSON numbers safely", () => {
    const content = jsonl(row()).replace('"output_tokens":2', '"output_tokens":1e309');
    const batch = parseClaudeCode(content, context);
    expect(batch.turns).toEqual([]);
    expect(batch.usage).toEqual([]);
    expect(batch.sessions).toEqual([]);
    expect(batch.issues).toEqual([
      createIssue(batch.source, "invalid_record", "1", context.ingestedAt),
    ]);
  });

  it("keeps stable source-qualified and session-qualified ids", () => {
    const content = jsonl(row(), row({ sessionId: "s2" }));
    const batch = parseClaudeCode(content, context);
    expect(parseClaudeCode(content, context)).toEqual(batch);
    expect(batch.turns.map((turn) => turn.id)).toEqual(
      ["s", "s2"].map((session) =>
        recordId(batch.source.id, "turn", JSON.stringify([session, "m"])),
      ),
    );
    for (const changed of [{ agent: "other" }, { path: "/synthetic/other.jsonl" }]) {
      const next = parseClaudeCode(content, { ...context, ...changed });
      expect(next.source).toEqual(createSource({ ...context, ...changed }));
      expect(next.turns[0]?.id).not.toBe(batch.turns[0]?.id);
    }
  });

  it("reports incomplete JSON and reparses a later complete snapshot", () => {
    const content = jsonl(row()).trimEnd();
    const broken = parseClaudeCode(content.slice(0, -1), context);
    expect(broken.turns).toEqual([]);
    expect(broken.issues).toEqual([
      createIssue(broken.source, "invalid_json", "1", context.ingestedAt),
    ]);
    expect(parseClaudeCode(content, context).usage).toHaveLength(1);
  });

  it("does not invent missing usage, successful results, or ordered tool duration", () => {
    const use = { type: "tool_use", id: "t", name: "Read", input: "SYNTHETIC_PRIVATE" };
    const batch = parseClaudeCode(
      jsonl(row({ message: { id: "m", content: [use, { ...use, id: "unresolved" }] } }), {
        type: "user",
        uuid: "u",
        sessionId: "s",
        timestamp: "2026-10-16T09:59:00.000Z",
        message: { content: [{ type: "tool_result", tool_use_id: "t", is_error: false }] },
      }),
      context,
    );
    expect(batch.usage).toEqual([]);
    expect(batch.toolCalls).toEqual([
      {
        id: recordId(batch.source.id, "tool", JSON.stringify(["s", "t"])),
        turn_id: batch.turns[0]?.id,
        tool: "Read",
        duration_ms: null,
        status: "ok",
      },
    ]);
    expect(batch.issues).toEqual([
      createIssue(batch.source, "missing_usage", "1", context.ingestedAt),
      createIssue(batch.source, "invalid_record", "1", context.ingestedAt),
    ]);
  });
});
