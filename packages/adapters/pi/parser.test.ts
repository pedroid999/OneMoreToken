import { readFileSync } from "node:fs";
import { ISSUE_MESSAGES, NormalizedBatchSchema, type ParseContext, recordId } from "@omt/core";
import { describe, expect, it } from "vitest";
import { GENTLE_SHELL_ADAPTER_VERSION, parseGentleShell } from "../gentle-shell";
import { PI_ADAPTER_VERSION, parsePi } from "./index";

const timestamp = "2026-01-01T00:00:00.000Z";
const context: ParseContext = {
  agent: "pi",
  path: "/synthetic/session.jsonl",
  adapterVersion: "pi-v3/1",
  ingestedAt: timestamp,
  pricing: {
    version: 1,
    currency: "USD",
    entries: [
      {
        provider: "synthetic",
        model: "model-a",
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
const header = { type: "session", version: 3, id: "session", timestamp, cwd: "/synthetic" };
const event = (id: string, parentId: string | null, extra: object) => ({
  id,
  parentId,
  timestamp,
  ...extra,
});
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
const assistant = (extra: object = {}) => ({
  type: "message",
  message: { role: "assistant", content: [], usage, ...extra },
});
const jsonl = (...records: unknown[]) => records.map((row) => JSON.stringify(row)).join("\n");
const parse = (...records: unknown[]) => {
  const batch = parsePi(jsonl(...records), context);
  expect(NormalizedBatchSchema.safeParse(batch).success).toBe(true);
  return batch;
};

describe("Pi v3 metrics-only parser", () => {
  it("snapshots reconstructed evidence, recovers corruption and never double charges", () => {
    const content = readFileSync(new URL("./fixtures/session.jsonl", import.meta.url), "utf8");
    const originalContext = structuredClone(context);
    const batch = parsePi(content, context);
    expect(context).toEqual(originalContext);
    expect(NormalizedBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.usage).toHaveLength(2);
    expect(batch.usage[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 40,
      reported_cost_usd: 0,
      computed_cost_usd: 0.00039,
    });
    expect(batch.usage[1]).toMatchObject({ reported_cost_usd: 0.25, computed_cost_usd: null });
    expect(
      batch.toolCalls.map(({ tool, status, duration_ms }) => [tool, status, duration_ms]),
    ).toEqual([
      ["read", "ok", 1000],
      ["execute", "error", 12],
    ]);
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["invalid_json", "8"],
      ["duplicate_usage", "12"],
    ]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_SENTINEL");
    expect(parsePi(content, context)).toEqual(batch);
    const gentle = parseGentleShell(content, { ...context, agent: "gentle-shell" });
    expect(NormalizedBatchSchema.safeParse(gentle).success).toBe(true);
    expect(gentle.usage.map(({ turn_id: _, ...metrics }) => metrics)).toEqual(
      batch.usage.map(({ turn_id: _, ...metrics }) => metrics),
    );
    expect(gentle.source.agent).toBe("gentle-shell");
    expect(gentle.source.id).not.toBe(batch.source.id);
    expect(PI_ADAPTER_VERSION).toBe("pi-v3/1");
    expect(GENTLE_SHELL_ADAPTER_VERSION).toBe("gentle-shell-v3/1");
    expect(batch).toMatchSnapshot();
  });

  it("inherits model/effort from tree ancestors, counting abandoned calls too", () => {
    const batch = parse(
      header,
      event("a", null, { type: "model_change", provider: "synthetic", modelId: "model-a" }),
      event("high", "a", { type: "thinking_level_change", thinkingLevel: "high" }),
      event("first", "high", assistant()),
      event("b", "first", { type: "model_change", provider: "other", modelId: "model-b" }),
      event("low", "b", { type: "thinking_level_change", thinkingLevel: "low" }),
      event("abandoned", "low", assistant()),
      event("branch", "first", assistant()),
      event("orphan", "missing", assistant()),
      event(
        "override",
        "branch",
        assistant({ provider: "explicit", model: "explicit", thinkingLevel: "off" }),
      ),
    );
    expect(batch.turns.map(({ model, provider, effort }) => [model, provider, effort])).toEqual([
      ["model-a", "synthetic", "high"],
      ["model-b", "other", "low"],
      ["model-a", "synthetic", "high"],
      [null, null, null],
      ["explicit", "explicit", "off"],
    ]);
    expect(batch.usage).toHaveLength(5);
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["invalid_record", "9"],
    ]);
    expect(batch.sessions[0]).toMatchObject({ title: null, branch: null, format_version: "3" });
    expect(batch).toMatchSnapshot();
  });

  it.each([undefined, 2, "3", 4])("rejects missing/unsupported header version %s", (version) => {
    const batch = parse({ ...header, version }, event("a", null, assistant()));
    expect([batch.sessions, batch.turns, batch.usage, batch.toolCalls]).toEqual([[], [], [], []]);
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["unsupported_format", "1"],
    ]);
    if (version === 2) expect(batch).toMatchSnapshot();
  });

  it("rejects absent headers and invalid header timestamps safely", () => {
    expect(parse(event("a", null, assistant())).sessions).toEqual([]);
    expect(parse().sessions).toEqual([]);
    const batch = parse({ ...header, timestamp: "PRIVATE_SENTINEL" });
    expect(batch.sessions).toEqual([]);
    expect(batch.issues[0]).toMatchObject({ code: "missing_timestamp", location: "1" });
  });

  it("isolates invalid metrics/timestamps and preserves valid subsequent records", () => {
    const batch = parse(
      header,
      event("missing", null, assistant({ usage: undefined })),
      event("negative", "missing", assistant({ usage: { ...usage, input: -1 } })),
      { ...event("bad-time", "negative", assistant()), timestamp: "PRIVATE_SENTINEL" },
      event("good", "bad-time", assistant({ usage: { ...usage, cost: { total: -1 } } })),
      event("total", "good", assistant({ usage: { ...usage, totalTokens: 99 } })),
    );
    expect(batch.turns).toHaveLength(4);
    expect(batch.usage).toHaveLength(1);
    expect(batch.usage[0]).toMatchObject({ reported_cost_usd: null, computed_cost_usd: null });
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["missing_usage", "2"],
      ["missing_usage", "3"],
      ["missing_timestamp", "4"],
      ["invalid_record", "5"],
      ["missing_usage", "6"],
    ]);
    for (const issue of batch.issues)
      expect(issue.message).toBe(ISSUE_MESSAGES[issue.code as keyof typeof ISSUE_MESSAGES]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_SENTINEL");
  });

  it("isolates unexpected JSON shapes and invalid metadata timestamps", () => {
    const batch = parse(
      header,
      null,
      [],
      event("malformed-role", null, { type: "message", message: { role: { toString: null } } }),
      {
        ...event("model", null, {
          type: "model_change",
          modelId: "model-a",
          provider: "synthetic",
        }),
        timestamp: "invalid",
      },
      event("valid", "model", assistant()),
    );
    expect(batch.usage).toHaveLength(1);
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["invalid_record", "2"],
      ["invalid_record", "3"],
      ["invalid_record", "4"],
      ["missing_timestamp", "5"],
    ]);
  });

  it("does not invent tool success or durations, and qualifies IDs by session", () => {
    const records = [
      event(
        "call",
        null,
        assistant({ content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] }),
      ),
      event("unknown", "call", {
        type: "message",
        message: { role: "toolResult", toolCallId: "unknown", isError: false },
      }),
      event("status", "call", {
        type: "message",
        message: { role: "toolResult", toolCallId: "tool" },
      }),
      {
        ...event("result", "call", {
          type: "message",
          message: { role: "toolResult", toolCallId: "tool", isError: false, durationMs: -1 },
        }),
        timestamp: "2025-12-31T23:59:59.000Z",
      },
    ];
    const batch = parse(header, ...records);
    expect(batch.toolCalls).toHaveLength(1);
    expect(batch.toolCalls[0]).toMatchObject({ status: "ok", duration_ms: null });
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["invalid_record", "3"],
      ["invalid_record", "4"],
    ]);
    const other = parse({ ...header, id: "other" }, ...records);
    for (const key of ["sessions", "turns", "toolCalls"] as const)
      expect(other[key][0]?.id).not.toBe(batch[key][0]?.id);
    expect(batch.turns[0]?.id).toBe(
      recordId(batch.source.id, "turn", JSON.stringify(["session", "call"])),
    );
  });
});
