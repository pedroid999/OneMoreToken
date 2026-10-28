import { readFileSync } from "node:fs";
import { NormalizedBatchSchema, type ParseContext, recordId, sourceFileId } from "@omt/core";
import { describe, expect, it } from "vitest";
import { GENTLE_SHELL_ADAPTER_VERSION, parseGentleShell } from "./index";
import {
  createGentleSubagentDocument,
  GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION,
  GENTLE_SHELL_SUBAGENT_FORMAT,
  type GentleTaskRecord,
  parseGentleShellSubagent,
  readGentleTaskRecord,
} from "./subagents";

const fixture = (path: string) =>
  readFileSync(new URL(`./fixtures/subagents/${path}`, import.meta.url), "utf8");
const parentPath = "/synthetic/agent/sessions/2026-01-01T00-00-00-000Z_parent-session.jsonl";
const context: ParseContext = {
  agent: "gentle-shell",
  path: "/synthetic/agent/gentle-agents/sessions/2026-01-02T00-00-00-000Z_child-linked.jsonl",
  adapterVersion: GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION,
  ingestedAt: "2026-01-05T00:00:00.000Z",
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
const record = (name: string) => readGentleTaskRecord(fixture(`tasks/${name}.json`));
const task = (name: string) => {
  const found = record(name);
  if (!found) throw new Error("Expected a task record");
  return found.task;
};
const parentId = recordId(
  sourceFileId("gentle-shell", parentPath),
  "session",
  JSON.stringify(["parent-session"]),
);
const linked = (
  tasks: GentleTaskRecord[],
  parents: Record<string, string> = { "parent-session": parentPath },
) =>
  parseGentleShellSubagent(
    createGentleSubagentDocument({
      session: fixture("sessions/2026-01-02T00-00-00-000Z_child-linked.jsonl"),
      tasks,
      parentPaths: parents,
    }),
    context,
  );

describe("gentle-shell task records", () => {
  it("keeps only metadata keys and the linked session file name", () => {
    const linkedRecord = record("task-linked");
    expect(linkedRecord).toEqual({
      sessionFile: "2026-01-02T00-00-00-000Z_child-linked.jsonl",
      task: {
        id: "task-linked",
        agent: "gentle-ai-worker",
        parentSessionId: "parent-session",
        model: "synthetic/model-a",
        thinking: "high",
        createdAt: 1767312000000,
        startedAt: 1767312000500,
        endedAt: 1767312060500,
      },
    });
    expect(JSON.stringify(linkedRecord)).not.toContain("PRIVATE_SENTINEL");
  });

  it.each([
    "not json",
    "[]",
    JSON.stringify({ task: { id: "t", agent: "a", parentSessionId: "p", createdAt: 1 } }),
    JSON.stringify({
      task: {
        id: "t",
        agent: "a",
        parentSessionId: "../p",
        createdAt: 1,
        sessionPath: "/x/s.jsonl",
      },
    }),
    JSON.stringify({
      task: { id: "t", agent: "a", parentSessionId: "p", createdAt: 1, sessionPath: "/x/s.txt" },
    }),
  ])("rejects an unusable record %#", (content) => {
    expect(readGentleTaskRecord(content)).toBeNull();
  });
});

describe("gentle-shell subagent parser", () => {
  it("links the child to its parent and sums the run from the child usage", () => {
    const batch = linked([task("task-resumed"), task("task-linked")]);
    expect(NormalizedBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch.sessions).toHaveLength(1);
    expect(batch.sessions[0]).toMatchObject({
      agent: "gentle-shell",
      format_version: GENTLE_SHELL_SUBAGENT_FORMAT,
      parent_session_id: parentId,
    });
    // The earliest task created the session; later tasks only extend its duration.
    expect(batch.subagentRuns).toEqual([
      {
        id: batch.sessions[0]?.id,
        parent_session_id: parentId,
        role: "gentle-ai-worker",
        model: "model-a",
        provider: "synthetic",
        effort: "high",
        started_at: "2026-01-02T00:00:00.500Z",
        duration_ms: 179500,
        input_tokens: 110,
        output_tokens: 25,
        cache_read_tokens: 30,
        cache_write_tokens: 40,
        reported_cost_usd: 0.75,
        computed_cost_usd: 0.00041,
      },
    ]);
    expect(batch.toolCalls).toHaveLength(1);
    expect(JSON.stringify(batch)).not.toContain("PRIVATE_SENTINEL");
    expect(linked([task("task-linked"), task("task-resumed")])).toEqual(batch);
    expect(batch).toMatchSnapshot();
  });

  it("ingests a child without a task record or resolvable parent with no run", () => {
    const orphan = parseGentleShellSubagent(
      createGentleSubagentDocument({
        session: fixture("sessions/2026-01-03T00-00-00-000Z_child-orphan.jsonl"),
        tasks: [],
        parentPaths: {},
      }),
      { ...context, path: "/synthetic/agent/gentle-agents/sessions/orphan.jsonl" },
    );
    expect(NormalizedBatchSchema.safeParse(orphan).success).toBe(true);
    expect(orphan.sessions[0]).toMatchObject({
      format_version: GENTLE_SHELL_SUBAGENT_FORMAT,
      parent_session_id: null,
    });
    expect(orphan.usage).toHaveLength(1);
    expect(orphan.subagentRuns).toEqual([]);
    const unresolved = linked([task("task-linked")], {});
    expect(unresolved.sessions[0]?.parent_session_id).toBeNull();
    expect(unresolved.subagentRuns).toEqual([]);
  });

  it("reports an unsupported document without rows", () => {
    for (const content of ["{", JSON.stringify({ format: "other" })]) {
      const batch = parseGentleShellSubagent(content, context);
      expect(batch.sessions).toEqual([]);
      expect(batch.issues.map(({ code }) => code)).toEqual([
        content === "{" ? "invalid_json" : "unsupported_format",
      ]);
    }
  });

  it("leaves parent gentle-shell sessions unchanged", () => {
    const parent = parseGentleShell(fixture(`parents/${parentPath.split("/").pop()}`), {
      ...context,
      path: parentPath,
      adapterVersion: GENTLE_SHELL_ADAPTER_VERSION,
    });
    expect(GENTLE_SHELL_ADAPTER_VERSION).toBe("gentle-shell-v3/3");
    expect(GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION).toBe("gentle-shell-subagent/2");
    expect(parent.sessions[0]).toMatchObject({
      id: parentId,
      format_version: "3",
      parent_session_id: null,
    });
    expect(parent.subagentRuns ?? []).toEqual([]);
  });
});
