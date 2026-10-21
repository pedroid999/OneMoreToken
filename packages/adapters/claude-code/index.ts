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
  TurnSchema,
  UsageSchema,
} from "@omt/core";

export const CLAUDE_CODE_ADAPTER_VERSION = "claude-code-jsonl-v1";

type ObjectRow = Record<string, unknown>;
const object = (value: unknown): ObjectRow => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  return value as ObjectRow;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.length) throw new Error();
  return value;
};
const optionalText = (value: unknown): string | null => (value == null ? null : text(value));
const count = (value: unknown, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
};
const key = (session: string, native: string) => JSON.stringify([session, native]);
type Tool = { id: string; turn: string; name: string; ts: string; line: string };
type Result = { ts: string; error: boolean };

/** Pure metrics-only snapshot parser (spec §3, §4, §10).
 * `anthropic` identifies Claude API usage, never a subscription or account.
 * cost-state is cumulative, so it cannot supply per-turn reported cost.
 */
export const parseClaudeCode: SourceParser = (content, context) => {
  const source = createSource(context);
  const batch: NormalizedBatch = {
    source,
    sessions: [],
    turns: [],
    usage: [],
    toolCalls: [],
    issues: [],
  };
  const sessions = new Map<string, NormalizedBatch["sessions"][number]>();
  const turns = new Map<string, NormalizedBatch["turns"][number]>();
  const usage = new Map<string, NormalizedBatch["usage"][number]>();
  const tools = new Map<string, Tool>();
  const results = new Map<string, Result>();
  const issue = (code: IssueCode, line: string) => {
    const row = createIssue(source, code, line, context.ingestedAt);
    if (!batch.issues.some((existing) => existing.id === row.id)) batch.issues.push(row);
  };

  for (const [index, line] of content.split("\n").entries()) {
    const location = String(index + 1);
    if (!line.trim()) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      issue("invalid_json", location);
      continue;
    }
    try {
      const event = object(decoded);
      const type = text(event.type);
      if (type !== "assistant" && type !== "user") continue;
      const nativeSession = text(event.sessionId);
      const message = object(event.message);
      const nativeTurn = text(
        type === "assistant" ? (message.id ?? event.uuid) : (event.uuid ?? message.id),
      );
      const sessionId = recordId(source.id, "session", nativeSession);
      const turnId = recordId(source.id, "turn", key(nativeSession, nativeTurn));
      const turn = TurnSchema.parse({
        id: turnId,
        session_id: sessionId,
        idx: 0,
        role: type,
        ts: event.timestamp,
        model: type === "assistant" ? optionalText(message.model ?? event.requestedModel) : null,
        provider: type === "assistant" ? "anthropic" : null,
        effort: optionalText(event.perTurnEffort ?? event.effort),
        subscription_id: null,
      });
      const session = SessionSchema.parse({
        id: sessionId,
        source_id: source.id,
        agent: source.agent,
        cwd: optionalText(event.cwd),
        repo: null,
        branch: optionalText(event.gitBranch),
        started_at: turn.ts,
        ended_at: turn.ts,
        title: null,
        format_version: context.adapterVersion,
      });
      let metrics: NormalizedBatch["usage"][number] | undefined;
      if (type === "assistant" && message.usage != null) {
        const raw = object(message.usage);
        const cache = raw.cache_creation == null ? {} : object(raw.cache_creation);
        const cacheWrite =
          count(cache.ephemeral_1h_input_tokens, 0) + count(cache.ephemeral_5m_input_tokens, 0);
        metrics = UsageSchema.parse({
          turn_id: turnId,
          input_tokens: count(raw.input_tokens),
          output_tokens: count(raw.output_tokens),
          cache_read_tokens: count(raw.cache_read_input_tokens, 0),
          cache_write_tokens: count(raw.cache_creation_input_tokens, cacheWrite),
          reported_cost_usd: null,
          computed_cost_usd: null,
        });
      }
      const pendingTools: Tool[] = [];
      const pendingResults: [string, Result][] = [];
      if (
        message.content != null &&
        typeof message.content !== "string" &&
        !Array.isArray(message.content)
      ) {
        throw new Error();
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        const part = object(block);
        if (type === "assistant" && part.type === "tool_use") {
          const id = key(nativeSession, text(part.id));
          if (tools.has(id) && tools.get(id)?.turn !== turnId) throw new Error();
          pendingTools.push({
            id,
            turn: turnId,
            name: text(part.name),
            ts: turn.ts,
            line: location,
          });
        }
        if (type === "user" && part.type === "tool_result") {
          if (part.is_error !== undefined && typeof part.is_error !== "boolean") throw new Error();
          pendingResults.push([
            key(nativeSession, text(part.tool_use_id)),
            { ts: turn.ts, error: part.is_error === true },
          ]);
        }
      }
      // Validate before updating shared snapshot state: a bad row cannot poison good rows.
      const previous = usage.get(turnId);
      const previousTurn = turns.get(turnId);
      if (!metrics && previous && previousTurn?.model === null && turn.model !== null) {
        metrics = { ...previous };
      }
      if (metrics) {
        if (previous) {
          // Stream blocks repeat counters; retain final tallies without summing blocks.
          for (const field of [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
          ] as const) {
            metrics[field] = Math.max(metrics[field], previous[field]);
          }
        }
        const model = previousTurn?.model ?? turn.model;
        metrics.computed_cost_usd =
          model === null
            ? null
            : calculateCost(
                metrics,
                "anthropic",
                model,
                previousTurn?.ts ?? turn.ts,
                context.pricing,
              );
        metrics = UsageSchema.parse(metrics);
      }
      const existing = sessions.get(sessionId);
      if (existing) {
        if (Date.parse(turn.ts) < Date.parse(existing.started_at)) existing.started_at = turn.ts;
        if (existing.ended_at === null || Date.parse(turn.ts) > Date.parse(existing.ended_at))
          existing.ended_at = turn.ts;
        existing.cwd ??= session.cwd;
        existing.branch ??= session.branch;
      } else {
        sessions.set(sessionId, { ...session, title: null });
      }
      // Tool-result envelopes are not additional conversational turns or assistant usage.
      if (type === "assistant" || pendingResults.length === 0) {
        if (!previousTurn) {
          turn.idx = [...turns.values()].filter((entry) => entry.session_id === sessionId).length;
          turns.set(turnId, { ...turn, subscription_id: null });
        } else {
          previousTurn.model ??= turn.model;
          previousTurn.effort ??= turn.effort;
        }
      }
      if (metrics) usage.set(turnId, metrics);
      if (type === "assistant" && !metrics && !previous) issue("missing_usage", location);
      for (const tool of pendingTools) if (!tools.has(tool.id)) tools.set(tool.id, tool);
      for (const [id, result] of pendingResults) if (!results.has(id)) results.set(id, result);
    } catch {
      issue("invalid_record", location);
    }
  }
  for (const tool of tools.values()) {
    const result = results.get(tool.id);
    if (!result) {
      issue("invalid_record", tool.line);
      continue;
    }
    const duration = Date.parse(result.ts) - Date.parse(tool.ts);
    batch.toolCalls.push({
      id: recordId(source.id, "tool", tool.id),
      turn_id: tool.turn,
      tool: tool.name,
      duration_ms: duration >= 0 ? duration : null,
      status: result.error ? "error" : "ok",
    });
  }
  batch.sessions = [...sessions.values()];
  batch.turns = [...turns.values()];
  batch.usage = [...usage.values()];
  return NormalizedBatchSchema.parse(batch);
};
