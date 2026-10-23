import { readFileSync } from "node:fs";
import { ISSUE_MESSAGES, NormalizedBatchSchema, type ParseContext, recordId } from "@omt/core";
import { describe, expect, it } from "vitest";
import { GENTLE_SHELL_ADAPTER_VERSION, parseGentleShell } from "../gentle-shell";
import { PI_ADAPTER_VERSION, parsePi } from "./index";

const timestamp = "2026-01-01T00:00:00.000Z";
const context: ParseContext = {
  agent: "pi",
  path: "/synthetic/session.jsonl",
  adapterVersion: PI_ADAPTER_VERSION,
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
const compaction = (extra: object = {}) => ({
  type: "compaction",
  summary: "PRIVATE_SENTINEL",
  firstKeptEntryId: "model",
  tokensBefore: 4321,
  details: { readFiles: ["PRIVATE_SENTINEL"], modifiedFiles: [] },
  systemMessage: { role: "system", content: "PRIVATE_SENTINEL", toolsAdded: [], timestamp: 1 },
  fromHook: false,
  ...extra,
});
const usageEntry = (kind: string, extra: object = {}) => ({
  type: "usage",
  kind,
  provider: "synthetic",
  model: "model-a",
  usage,
  ...extra,
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
    expect(batch.usage).toHaveLength(5);
    expect(batch.usage[0]).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 40,
      reported_cost_usd: 0,
      computed_cost_usd: 0.00039,
    });
    expect(batch.usage[1]).toMatchObject({ reported_cost_usd: 0.25, computed_cost_usd: null });
    expect(batch.usage[2]).toMatchObject({
      input_tokens: 5,
      output_tokens: 6,
      cache_read_tokens: 7,
      cache_write_tokens: 8,
      reported_cost_usd: 0.5,
      computed_cost_usd: null,
    });
    expect(batch.usage[3]).toMatchObject({
      cache_read_tokens: 1000,
      reported_cost_usd: 0.015,
      computed_cost_usd: 0.003,
    });
    expect(batch.usage[4]).toMatchObject({
      input_tokens: 10,
      reported_cost_usd: null,
      computed_cost_usd: 0.00001,
    });
    expect(
      batch.turns
        .slice(-4)
        .map(({ role, is_compaction, model, effort }) => [role, is_compaction, model, effort]),
    ).toEqual([
      ["compaction", true, "unpriced", "low"],
      ["usage", false, "model-a", null],
      ["usage", false, "model-a", null],
      ["compaction", true, "unpriced", "low"],
    ]);
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
    expect(PI_ADAPTER_VERSION).toBe("pi-v3/2");
    expect(GENTLE_SHELL_ADAPTER_VERSION).toBe("gentle-shell-v3/2");
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

  it("marks compactions with inherited state and counts their optional usage like assistants", () => {
    const batch = parse(
      header,
      event("model", null, { type: "model_change", provider: "synthetic", modelId: "model-a" }),
      event("effort", "model", { type: "thinking_level_change", thinkingLevel: "high" }),
      event("with", "effort", compaction({ usage: { ...usage, cost: { total: 0.5 } } })),
      event("without", "with", compaction()),
      event("negative", "without", compaction({ usage: { ...usage, input: -1 } })),
      event("total", "negative", compaction({ usage: { ...usage, totalTokens: 99 } })),
      event("cost", "total", compaction({ usage: { ...usage, cost: { total: -1 } } })),
      { ...event("bad-time", "cost", compaction({ usage })), timestamp: "PRIVATE_SENTINEL" },
      event("with", "cost", compaction({ usage })),
      event("after", "cost", assistant()),
    );
    expect(
      batch.turns.map(({ role, is_compaction, model, provider, effort }) => [
        role,
        is_compaction,
        model,
        provider,
        effort,
      ]),
    ).toEqual([
      ...Array.from({ length: 5 }, () => ["compaction", true, "model-a", "synthetic", "high"]),
      ["assistant", false, "model-a", "synthetic", "high"],
    ]);
    const turnId = (native: string) =>
      recordId(batch.source.id, "turn", JSON.stringify(["session", native]));
    expect(batch.usage).toEqual([
      {
        turn_id: turnId("with"),
        ...{ input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 },
        reported_cost_usd: 0.5,
        computed_cost_usd: 0.00003,
      },
      expect.objectContaining({
        turn_id: turnId("cost"),
        reported_cost_usd: null,
        computed_cost_usd: 0.00003,
      }),
      expect.objectContaining({ turn_id: turnId("after"), computed_cost_usd: 0.00003 }),
    ]);
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["missing_usage", "6"],
      ["missing_usage", "7"],
      ["invalid_record", "8"],
      ["missing_timestamp", "9"],
      ["duplicate_usage", "10"],
    ]);
    expect(JSON.stringify(batch)).not.toMatch(/PRIVATE_SENTINEL|4321|readFiles|toolsAdded/);
  });

  it("counts usage entries of any kind with the entry model/provider", () => {
    const batch = parse(
      header,
      event("model", null, { type: "model_change", provider: "other", modelId: "model-b" }),
      event("effort", "model", { type: "thinking_level_change", thinkingLevel: "low" }),
      event(
        "warm",
        "effort",
        usageEntry("cache_warm", { usage: { ...usage, cost: { total: 0.015 } } }),
      ),
      event("future", "warm", usageEntry("synthetic_future_kind")),
      event("unpriced", "future", usageEntry("cache_warm", { model: "unpriced" })),
      event(
        "bad",
        "unpriced",
        usageEntry("cache_warm", { usage: { ...usage, output: "PRIVATE_SENTINEL" } }),
      ),
      event("warm", "bad", usageEntry("cache_warm")),
      event("after", "bad", assistant()),
    );
    expect(
      batch.turns.map(({ role, is_compaction, model, provider, effort }) => [
        role,
        is_compaction,
        model,
        provider,
        effort,
      ]),
    ).toEqual([
      ["usage", false, "model-a", "synthetic", null],
      ["usage", false, "model-a", "synthetic", null],
      ["usage", false, "unpriced", "synthetic", null],
      ["usage", false, "model-a", "synthetic", null],
      ["assistant", false, "model-b", "other", "low"],
    ]);
    expect(
      batch.usage.map(({ reported_cost_usd, computed_cost_usd }) => [
        reported_cost_usd,
        computed_cost_usd,
      ]),
    ).toEqual([
      [0.015, 0.00003],
      [null, 0.00003],
      [null, null],
      [null, null],
    ]);
    expect(batch.usage[0]).toMatchObject({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_write_tokens: 4,
    });
    expect(batch.issues.map(({ code, location }) => [code, location])).toEqual([
      ["missing_usage", "7"],
      ["duplicate_usage", "8"],
    ]);
    expect(JSON.stringify(batch)).not.toMatch(/PRIVATE_SENTINEL|cache_warm|synthetic_future_kind/);
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
