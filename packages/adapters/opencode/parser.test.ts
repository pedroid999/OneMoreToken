import { NormalizedBatchSchema, type ParseContext, recordId, sourceFileId } from "@omt/core";
import { describe, expect, it } from "vitest";
import type { OpenCodeDocument, OpenCodeMessage } from "./document";
import { OPENCODE_ADAPTER_VERSION, parseOpenCode } from "./index";

const context: ParseContext = {
  agent: "opencode",
  path: "/synthetic/opencode/sessions/ses_parent",
  adapterVersion: "opencode/1",
  ingestedAt: "2026-01-10T00:00:00.000Z",
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
const created = 1767225600000;
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 40 } };
const message = (id: string, extra: Partial<OpenCodeMessage> = {}): OpenCodeMessage => ({
  id,
  role: "assistant",
  time: { created, completed: created + 1000 },
  modelID: "model-a",
  providerID: "synthetic",
  variant: null,
  mode: "build",
  summary: null,
  cost: 0.5,
  tokens,
  parts: [],
  ...extra,
});
const document = (
  messages: OpenCodeDocument["messages"],
  session: Partial<OpenCodeDocument["session"]> = {},
): OpenCodeDocument => ({
  format: 1,
  origin: "sqlite",
  session: {
    id: "ses_parent",
    parentId: null,
    directory: "/synthetic/project",
    version: "1.0.0-synthetic",
    created,
    updated: created + 600000,
    ...session,
  },
  messages,
});
const parse = (doc: unknown, ctx = context) => {
  const batch = parseOpenCode(JSON.stringify(doc), ctx);
  expect(NormalizedBatchSchema.safeParse(batch).success).toBe(true);
  return batch;
};
const issues = (batch: ReturnType<typeof parse>) =>
  batch.issues.map(({ code, location }) => [code, location]);

describe("OpenCode canonical document parser", () => {
  it("maps one turn per message, reasoning as output, both costs, tools and compaction", () => {
    const doc = document([
      message("msg_p1", {
        role: "user",
        modelID: null,
        providerID: null,
        mode: null,
        cost: null,
        tokens: null,
      }),
      message("msg_p2", {
        variant: "high",
        parts: [
          {
            type: "tool",
            callID: "call_read",
            tool: "read",
            status: "completed",
            start: 1,
            end: 1501,
          },
          { type: "tool", callID: "call_bash", tool: "bash", status: "error", start: 5, end: 17 },
          {
            type: "tool",
            callID: "call_edit",
            tool: "edit",
            status: "running",
            start: 9,
            end: null,
          },
        ],
      }),
      message("msg_p3", {
        role: "user",
        time: { created: created + 300000, completed: null },
        modelID: null,
        providerID: null,
        mode: null,
        cost: null,
        tokens: null,
        parts: [{ type: "compaction" }],
      }),
      message("msg_p4", { mode: "compaction", summary: true, providerID: "other" }),
      message("msg_p5", { tokens: null }),
    ]);
    const original = structuredClone(context);
    const batch = parse(doc);
    expect(context).toEqual(original);
    expect(OPENCODE_ADAPTER_VERSION).toBe("opencode/1");
    expect(batch.sessions).toEqual([
      expect.objectContaining({
        id: recordId(batch.source.id, "session", "ses_parent"),
        cwd: "/synthetic/project",
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: "2026-01-01T00:10:00.000Z",
        format_version: "opencode-sqlite/1.0.0-synthetic",
        parent_session_id: null,
        title: null,
      }),
    ]);
    expect(
      batch.turns.map(({ role, model, provider, effort, is_compaction }) => [
        role,
        model,
        provider,
        effort,
        is_compaction,
      ]),
    ).toEqual([
      ["user", null, null, null, false],
      ["assistant", "model-a", "synthetic", "high", false],
      ["user", null, null, null, true],
      ["assistant", "model-a", "other", null, false],
      ["assistant", "model-a", "synthetic", null, false],
    ]);
    expect(batch.usage).toHaveLength(2);
    expect(batch.usage[0]).toMatchObject({
      turn_id: batch.turns[1]?.id,
      input_tokens: 100,
      output_tokens: 25,
      cache_read_tokens: 30,
      cache_write_tokens: 40,
      reported_cost_usd: 0.5,
      computed_cost_usd: 0.0004,
    });
    expect(batch.usage[1]).toMatchObject({ reported_cost_usd: 0.5, computed_cost_usd: null });
    expect(
      batch.toolCalls.map(({ tool, status, duration_ms }) => [tool, status, duration_ms]),
    ).toEqual([
      ["read", "ok", 1500],
      ["bash", "error", 12],
    ]);
    expect(issues(batch)).toEqual([["missing_usage", "10"]]);
    expect(parseOpenCode(JSON.stringify(doc), context)).toEqual(batch);
    expect(batch).toMatchSnapshot();
  });

  it("links a child session to its parent's virtual session source", () => {
    const path = "/synthetic/opencode/sessions/ses_child";
    const batch = parse(document([], { id: "ses_child", parentId: "ses_parent", version: null }), {
      ...context,
      path,
    });
    expect(batch.sessions[0]).toMatchObject({
      parent_session_id: recordId(
        sourceFileId("opencode", "/synthetic/opencode/sessions/ses_parent"),
        "session",
        "ses_parent",
      ),
      format_version: "opencode-sqlite/unknown",
    });
    const unsafe = parse(document([], { id: "ses_child", parentId: "../x" }), { ...context, path });
    expect(unsafe.sessions[0]?.parent_session_id).toBeNull();
    expect(issues(unsafe)).toEqual([["invalid_record", "1"]]);
  });

  it("reports unreadable entries by document position and keeps the rest", () => {
    const batch = parse({
      ...document([
        null,
        message("msg_a", {
          parts: [
            null,
            { type: "tool", callID: "c", tool: "read", status: "completed", start: 2, end: 1 },
          ],
        }),
        message("msg_b", { role: "system" }),
        message("msg_c", { time: { created: null, completed: null } }),
        message("msg_d", { cost: -1, tokens: { ...tokens, input: -1 } }),
        message("msg_e", { cost: -1 }),
      ]),
      origin: "legacy",
    });
    expect(batch.sessions[0]?.format_version).toBe("opencode-legacy/1.0.0-synthetic");
    expect(batch.turns.map(({ id }) => id)).toHaveLength(3);
    expect(batch.toolCalls).toEqual([expect.objectContaining({ tool: "read", duration_ms: null })]);
    expect(batch.usage.map(({ reported_cost_usd }) => reported_cost_usd)).toEqual([0.5, null]);
    expect(issues(batch)).toEqual([
      ["invalid_json", "2"],
      ["invalid_json", "4"],
      ["invalid_record", "6"],
      ["missing_timestamp", "7"],
      ["missing_usage", "8"],
      ["invalid_record", "9"],
    ]);
  });

  it.each([
    ["PRIVATE_SENTINEL", "invalid_json"],
    [JSON.stringify({ ...document([]), format: 2 }), "unsupported_format"],
    [JSON.stringify([]), "unsupported_format"],
    [JSON.stringify(document([], { id: "../escape" })), "invalid_record"],
    [JSON.stringify(document([], { created: null })), "missing_timestamp"],
  ])("rejects an unusable document %#", (content, code) => {
    const batch = parseOpenCode(content, context);
    expect(NormalizedBatchSchema.safeParse(batch).success).toBe(true);
    expect([batch.sessions, batch.turns, batch.usage, batch.toolCalls]).toEqual([[], [], [], []]);
    expect(issues(batch)).toEqual([[code, "1"]]);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_SENTINEL");
  });
});
