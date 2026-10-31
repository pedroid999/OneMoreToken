import {
  calculateCost,
  createIssue,
  createSource,
  type IssueCode,
  type NormalizedBatch,
  NormalizedBatchSchema,
  recordId,
  SessionSchema,
  type SourceParser,
  sourceFileId,
  TurnSchema,
  UsageSchema,
} from "@omt/core";

/** codex/2: batches also carry the provider's `rate_limits` readings (Phase 4 T1b). */
export const CODEX_ADAPTER_VERSION = "codex/2";
/** Session format versions (spec §3): current rollouts and the 2025 layout without usage. */
const ROLLOUT_FORMAT = "codex-rollout/1";
const LEGACY_FORMAT = "codex-legacy/1";
const DOCUMENT_FORMAT = "omt-codex-document/1";

type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): ObjectRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectRecord)
    : {};
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const iso = (value: unknown) => {
  const parsed = TurnSchema.shape.ts.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const count = (value: unknown, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
};
const lines = (content: string) =>
  content.split("\n").flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ location: String(index + 1), value: object(JSON.parse(line)), ok: true }];
    } catch {
      return [{ location: String(index + 1), value: {}, ok: false }];
    }
  });

/** Thread id and parent thread id from the first `session_meta` record, or null. */
export function codexSessionMeta(rollout: string): { id: string; parentId: string | null } | null {
  for (const line of lines(rollout)) {
    if (!line.ok) continue;
    if (line.value.type !== "session_meta") return null;
    const payload = object(line.value.payload);
    const id = text(payload.id);
    if (!id) return null;
    const spawn = object(object(object(payload.source).subagent).thread_spawn);
    return { id, parentId: text(spawn.parent_thread_id) };
  }
  return null;
}

/** Wraps a subagent rollout with the path of its parent rollout, so the pure parser can derive the
 * parent session id (D1). The wrapper is the checkpointed content: a moved parent re-parses. */
export function createCodexDocument(input: { rollout: string; parentPath: string }): string {
  return JSON.stringify({
    format: DOCUMENT_FORMAT,
    parentPath: input.parentPath,
    rollout: input.rollout,
  });
}
const unwrap = (content: string): { rollout: string; parentPath: string | null } => {
  if (!content.startsWith(`{"format":"${DOCUMENT_FORMAT}"`)) {
    return { rollout: content, parentPath: null };
  }
  try {
    const document = object(JSON.parse(content));
    const rollout = typeof document.rollout === "string" ? document.rollout : "";
    return { rollout, parentPath: text(document.parentPath) };
  } catch {
    return { rollout: content, parentPath: null };
  }
};

export interface CodexQuotaReading {
  observedAt: string;
  windowKind: "five_hours" | "weekly";
  observedPct: number;
  resetsAt: string;
}
const WINDOWS: Record<number, CodexQuotaReading["windowKind"]> = {
  300: "five_hours",
  10080: "weekly",
};

/** Provider-reported `rate_limits` from `token_count` events (D2). Only the window length, used
 * percentage and reset time are read; unknown windows or invalid values are skipped. */
export function readCodexQuotaReadings(content: string): CodexQuotaReading[] {
  const readings: CodexQuotaReading[] = [];
  for (const line of lines(unwrap(content).rollout)) {
    const payload = object(line.value.payload);
    if (line.value.type !== "event_msg" || payload.type !== "token_count") continue;
    const observedAt = iso(line.value.timestamp);
    if (!observedAt) continue;
    const limits = object(payload.rate_limits);
    for (const key of ["primary", "secondary"]) {
      const limit = object(limits[key]);
      const windowKind = WINDOWS[limit.window_minutes as number];
      const pct = limit.used_percent;
      const reset = limit.resets_at;
      if (!windowKind || typeof pct !== "number" || !(pct >= 0 && pct <= 100)) continue;
      if (typeof reset !== "number" || !Number.isFinite(reset)) continue;
      readings.push({
        observedAt,
        windowKind,
        observedPct: pct,
        resetsAt: new Date(reset * 1000).toISOString(),
      });
    }
  }
  return readings;
}

type Tool = { callId: string; name: string; ts: string; turnKey: string | null; line: string };

/** Pure metrics-only parser for Codex CLI rollouts (spec §3, §10).
 * One `token_usage_record` is one assistant turn; one `task_started` is one user turn. Model and
 * effort come from the latest `turn_context` of the same Codex turn. OpenAI `input_tokens`
 * include cached input, so cached tokens are moved to `cache_read_tokens`. Messages, reasoning,
 * tool input/output, instructions and repository URLs are never read into the batch.
 */
export const parseCodex: SourceParser = (content, context) => {
  const source = createSource(context);
  const batch: NormalizedBatch = {
    source,
    sessions: [],
    turns: [],
    usage: [],
    toolCalls: [],
    issues: [],
  };
  const issue = (code: IssueCode, location: string | null) => {
    const row = createIssue(source, code, location, context.ingestedAt);
    if (!batch.issues.some((existing) => existing.id === row.id)) batch.issues.push(row);
  };
  const { rollout, parentPath } = unwrap(content);
  const records = lines(rollout);
  const first = records.find((line) => line.ok);
  const legacy = first && first.value.type === undefined && text(first.value.id);
  if (legacy) {
    const started = iso(first.value.timestamp);
    if (!started) {
      issue("missing_timestamp", first.location);
      return NormalizedBatchSchema.parse(batch);
    }
    batch.sessions.push({
      ...SessionSchema.parse({
        id: recordId(source.id, "session", legacy),
        source_id: source.id,
        agent: source.agent,
        cwd: null,
        repo: null,
        branch: text(object(first.value.git).branch),
        started_at: started,
        ended_at: started,
        title: null,
        format_version: LEGACY_FORMAT,
        parent_session_id: null,
      }),
      title: null,
    });
    issue("missing_usage", null);
    return NormalizedBatchSchema.parse(batch);
  }
  const meta = first?.value.type === "session_meta" ? object(first.value.payload) : null;
  const native = meta ? text(meta.id) : null;
  const started = meta ? iso(meta.timestamp ?? first?.value.timestamp) : null;
  if (!meta || !native || !started) {
    issue("unsupported_format", first?.location ?? null);
    return NormalizedBatchSchema.parse(batch);
  }
  const provider = text(meta.model_provider) ?? "openai";
  const spawn = object(object(object(meta.source).subagent).thread_spawn);
  const parentNative = text(spawn.parent_thread_id);
  const sessionId = recordId(source.id, "session", native);
  const parent =
    parentNative && parentPath
      ? recordId(sourceFileId(context.agent, parentPath), "session", parentNative)
      : null;
  const session = SessionSchema.parse({
    id: sessionId,
    source_id: source.id,
    agent: source.agent,
    cwd: text(meta.cwd),
    repo: null,
    branch: text(object(meta.git).branch),
    started_at: started,
    ended_at: started,
    title: null,
    format_version: ROLLOUT_FORMAT,
    parent_session_id: parent,
  });
  const contexts = new Map<string, { model: string | null; effort: string | null }>();
  const latestByTurn = new Map<string, string>();
  const pending: Tool[] = [];
  const tools = new Map<string, Tool & { turn: string | null }>();
  const outputs = new Map<string, string>();
  const seen = new Set<string>();
  const touch = (ts: string) => {
    if (Date.parse(ts) > Date.parse(session.ended_at ?? ts)) session.ended_at = ts;
  };
  const addTurn = (id: string, role: string, ts: string, turnKey: string | null) => {
    const settings = turnKey ? contexts.get(turnKey) : undefined;
    batch.turns.push({
      ...TurnSchema.parse({
        id,
        session_id: sessionId,
        idx: batch.turns.length,
        role,
        ts,
        model: role === "assistant" ? (settings?.model ?? null) : null,
        provider: role === "assistant" ? provider : null,
        effort: role === "assistant" ? (settings?.effort ?? null) : null,
        subscription_id: null,
        is_compaction: false,
      }),
      subscription_id: null,
    });
    touch(ts);
  };

  for (const line of records) {
    if (!line.ok) {
      issue("invalid_json", line.location);
      continue;
    }
    if (line === first) continue;
    try {
      const type = line.value.type;
      const payload = object(line.value.payload);
      const ts = iso(line.value.timestamp);
      if (!ts) throw new Error();
      if (type === "turn_context") {
        const turnKey = text(payload.turn_id);
        if (turnKey) {
          contexts.set(turnKey, { model: text(payload.model), effort: text(payload.effort) });
        }
      } else if (type === "event_msg" && payload.type === "task_started") {
        const turnKey = text(payload.turn_id);
        if (!turnKey) throw new Error();
        addTurn(recordId(source.id, "turn", `task:${turnKey}`), "user", ts, turnKey);
      } else if (type === "token_usage_record") {
        const response = text(payload.response_id);
        const turnKey = text(payload.turn_id);
        if (!response) throw new Error();
        const raw = object(payload.usage);
        const input = count(raw.input_tokens);
        const cached = count(raw.cached_input_tokens, 0);
        if (cached > input) throw new Error();
        const tokens = {
          input_tokens: input - cached,
          output_tokens: count(raw.output_tokens),
          cache_read_tokens: cached,
          cache_write_tokens: count(raw.cache_write_input_tokens, 0),
        };
        const turnId = recordId(source.id, "turn", response);
        if (seen.has(turnId)) {
          issue("duplicate_usage", line.location);
          continue;
        }
        seen.add(turnId);
        addTurn(turnId, "assistant", ts, turnKey);
        const model = turnKey ? (contexts.get(turnKey)?.model ?? null) : null;
        batch.usage.push(
          UsageSchema.parse({
            turn_id: turnId,
            ...tokens,
            reported_cost_usd: null,
            computed_cost_usd:
              model === null
                ? null
                : calculateCost(
                    { ...tokens, cache_write_1h_tokens: 0 },
                    provider,
                    model,
                    ts,
                    context.pricing,
                  ),
          }),
        );
        // Calls emitted before this record belong to the response that produced them.
        for (const tool of pending.splice(0)) tools.set(tool.callId, { ...tool, turn: turnId });
        if (turnKey) latestByTurn.set(turnKey, turnId);
      } else if (type === "response_item") {
        const kind = payload.type;
        if (kind === "function_call" || kind === "custom_tool_call") {
          const callId = text(payload.call_id);
          const name = text(payload.name);
          if (!callId || !name) throw new Error();
          const turnKey = text(object(payload.internal_chat_message_metadata_passthrough).turn_id);
          pending.push({ callId, name, ts, turnKey, line: line.location });
        } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
          const callId = text(payload.call_id);
          if (!callId) throw new Error();
          if (!outputs.has(callId)) outputs.set(callId, ts);
        }
        touch(ts);
      } else if (type === "event_msg") {
        touch(ts);
      }
    } catch {
      issue("invalid_record", line.location);
    }
  }
  // A call without a later usage record in the file belongs to the last response of its turn.
  for (const tool of pending) {
    const turn = tool.turnKey ? (latestByTurn.get(tool.turnKey) ?? null) : null;
    tools.set(tool.callId, { ...tool, turn });
  }
  for (const tool of tools.values()) {
    const done = outputs.get(tool.callId);
    if (!tool.turn) {
      issue("invalid_record", tool.line);
      continue;
    }
    const duration = done ? Date.parse(done) - Date.parse(tool.ts) : null;
    batch.toolCalls.push({
      id: recordId(source.id, "tool", tool.callId),
      turn_id: tool.turn,
      tool: tool.name,
      duration_ms: duration !== null && duration >= 0 ? duration : null,
      status: "ok",
    });
  }
  if (batch.usage.length === 0) issue("missing_usage", null);
  batch.sessions.push({ ...session, title: null });
  // Ids follow the reading's position in the file, stable while the rollout only grows.
  const readings = readCodexQuotaReadings(rollout);
  if (readings.length > 0) {
    batch.quotaReadings = readings.map((reading, index) => ({
      id: recordId(source.id, "quota", String(index)),
      source_id: source.id,
      origin: "codex",
      window_kind: reading.windowKind,
      observed_at: reading.observedAt,
      observed_pct: reading.observedPct,
      resets_at: reading.resetsAt,
    }));
  }
  if (parent) {
    const usage = batch.usage;
    const firstAssistant = batch.turns.find((turn) => turn.role === "assistant");
    const sum = (values: (number | null)[]) => {
      const known = values.filter((value): value is number => value !== null);
      return known.length > 0 ? Number(known.reduce((a, b) => a + b, 0).toPrecision(12)) : null;
    };
    const ended = Date.parse(session.ended_at ?? session.started_at);
    batch.subagentRuns = [
      {
        id: sessionId,
        parent_session_id: parent,
        role: text(spawn.agent_role) ?? "subagent",
        model: firstAssistant?.model ?? null,
        provider,
        effort: firstAssistant?.effort ?? null,
        started_at: session.started_at,
        duration_ms: ended - Date.parse(session.started_at),
        input_tokens: usage.reduce((total, row) => total + row.input_tokens, 0),
        output_tokens: usage.reduce((total, row) => total + row.output_tokens, 0),
        cache_read_tokens: usage.reduce((total, row) => total + row.cache_read_tokens, 0),
        cache_write_tokens: usage.reduce((total, row) => total + row.cache_write_tokens, 0),
        reported_cost_usd: sum(usage.map((row) => row.reported_cost_usd)),
        computed_cost_usd: sum(usage.map((row) => row.computed_cost_usd)),
      },
    ];
  }
  return NormalizedBatchSchema.parse(batch);
};
