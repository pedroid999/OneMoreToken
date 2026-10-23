import { describe, expect, it } from "vitest";
import type { SessionTurn } from "../../cli/src/sessions/contract";
import {
  contextRows,
  contextSpec,
  detailRequest,
  isSessionId,
  listRequest,
  parseSessionState,
  sessionSearch,
  toolsSummary,
} from "../src/session/state";

const ID = `${"a".repeat(64)}:session:${"b".repeat(64)}`;
const DAY = 86_400_000;
const anchor = Date.parse("2026-01-08T00:00:00.000Z");

const turn = (patch: Partial<SessionTurn>): SessionTurn => ({
  idx: 0,
  role: "assistant",
  ts: "2026-01-01T00:00:00.000Z",
  model: null,
  provider: null,
  effort: null,
  isCompaction: false,
  tokens: null,
  contextTokens: null,
  costs: { reported: null, computed: null },
  tools: [],
  ...patch,
});

describe("session URL state (S11: the URL is the state; L21 UI routes)", () => {
  it("defaults to the rolling seven days and no agent or id", () => {
    expect(parseSessionState("", anchor)).toEqual({
      from: new Date(anchor - 7 * DAY).toISOString(),
      to: new Date(anchor).toISOString(),
    });
  });

  it("reads explicit bounds, a known agent and the session id", () => {
    expect(
      parseSessionState(
        `?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&agent=pi&id=${ID}`,
        anchor,
      ),
    ).toEqual({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T00:00:00.000Z",
      agent: "pi",
      id: ID,
    });
  });

  it("drops unknown agents but keeps any id so the view can report it", () => {
    expect(parseSessionState("?agent=codex&id=nope", anchor)).toMatchObject({ id: "nope" });
    expect(parseSessionState("?agent=codex", anchor).agent).toBeUndefined();
  });

  it("builds list and detail requests from period, agent and id only", () => {
    const state = parseSessionState(
      "?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&agent=opencode&lang=es",
      anchor,
    );
    expect(listRequest(state)).toBe(
      "/api/sessions?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z&agent=opencode",
    );
    expect(listRequest({ ...state, agent: undefined })).toBe(
      "/api/sessions?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-02T00%3A00%3A00.000Z",
    );
    expect(detailRequest(ID)).toBe(`/api/sessions/${ID}`);
  });

  it("validates ids with the stored record id shape", () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId("nope")).toBe(false);
    expect(isSessionId(ID.toUpperCase())).toBe(false);
  });

  it("patches the query without losing unrelated parameters", () => {
    const search = "?from=a&to=b&theme=x";
    expect(sessionSearch(search, { id: ID })).toBe(
      `?from=a&to=b&theme=x&id=${encodeURIComponent(ID)}`,
    );
    expect(sessionSearch(`${search}&id=${ID}`, { id: undefined })).toBe(search);
    expect(sessionSearch(search, { agent: "pi" })).toBe("?from=a&to=b&theme=x&agent=pi");
    expect(sessionSearch("?agent=pi", { agent: undefined })).toBe("");
  });
});

describe("context curve (S10, L21 context curve)", () => {
  it("keeps turns with usage and compaction markers, in idx order", () => {
    const turns = [
      turn({ idx: 0, role: "user" }),
      turn({ idx: 1, contextTokens: 10 }),
      turn({ idx: 2, role: "compaction", isCompaction: true }),
      turn({ idx: 3, contextTokens: 3 }),
    ];
    expect(contextRows(turns)).toEqual([
      { idx: 1, context: 10, compaction: false },
      { idx: 2, context: null, compaction: true },
      { idx: 3, context: 3, compaction: false },
    ]);
  });

  it("builds a data-free Vega-Lite layer: line for context, rules for compactions", () => {
    const spec = contextSpec({
      turn: "Turn",
      context: "Context",
      compaction: "Compaction",
    }) as { $schema: string; data: unknown; layer: Record<string, unknown>[] };
    expect(spec.$schema).toContain("/vega-lite/");
    expect(spec.data).toEqual({ name: "table" });
    expect(JSON.stringify(spec)).not.toContain("values");
    expect(spec.layer.map((layer) => (layer.mark as { type: string }).type)).toEqual([
      "line",
      "rule",
    ]);
    expect(JSON.stringify(spec)).toContain('"title":"Turn"');
    expect(JSON.stringify(spec)).toContain('"datum":"Compaction"');
    // Colors come from the theme config, never from the spec (spec §8.2).
    expect(JSON.stringify(spec)).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
});

describe("tools summary (S10, L21 tools summary)", () => {
  it("counts calls and errors and sums known durations per tool", () => {
    const turns = [
      turn({
        tools: [
          { tool: "read", status: "ok", durationMs: 10 },
          { tool: "edit", status: "error", durationMs: 5 },
        ],
      }),
      turn({
        tools: [
          { tool: "read", status: "error", durationMs: null },
          { tool: "bash", status: "ok", durationMs: null },
        ],
      }),
    ];
    expect(toolsSummary(turns)).toEqual([
      { tool: "read", calls: 2, errors: 1, durationMs: 10 },
      { tool: "bash", calls: 1, errors: 0, durationMs: null },
      { tool: "edit", calls: 1, errors: 1, durationMs: 5 },
    ]);
    expect(toolsSummary([turn({})])).toEqual([]);
  });
});
