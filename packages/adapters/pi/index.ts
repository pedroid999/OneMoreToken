import {
  calculateCost,
  createIssue,
  createSource,
  type IssueCode,
  type NormalizedBatch,
  NormalizedBatchSchema,
  type ProfileSnapshot,
  profileSnapshot,
  recordId,
  SESSION_PROFILE_CUSTOM_TYPE,
  SESSION_PROFILE_FAMILY,
  type SourceParser,
  TurnSchema,
  UsageSchema,
} from "@omt/core";

export const PI_ADAPTER_VERSION = "pi-v3/3";
/** Stored id of a Pi session: lets other sources link to it without reading it. */
export const piSessionId = (sourceId: string, nativeSession: string) =>
  recordId(sourceId, "session", JSON.stringify([nativeSession]));
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
const tokenSchema = UsageSchema.pick({
  input_tokens: true,
  output_tokens: true,
  cache_read_tokens: true,
  cache_write_tokens: true,
});
type Event = { data: ObjectRecord; id: string; parent: string | null; line: number };
/** `profile`: hash of the session profile bound on this branch (spec §6.2), null when none. */
type State = {
  model: string | null;
  provider: string | null;
  effort: string | null;
  profile: string | null;
};
const USAGE_TYPES = ["message", "compaction", "usage"];

/** Pure Pi v3 metrics (spec §3, §4, §10). All uniquely recorded API calls count,
 * including abandoned branches: they cost tokens. No active branch is inferred.
 * Fixtures reconstruct verified shapes; branch fixtures assert tree semantics only.
 * `compaction` entries are compaction turns with inherited state and optional summary usage;
 * `usage` entries count whatever their `kind`. Summaries, details and system messages are never read.
 * `gentle-pi.session-profile/v1` entries bind a profile to the following turns of their branch until a
 * `clear`, a newer bind or an invalid/unknown-version family entry; only the snapshot whitelist is kept.
 */
export const parsePi: SourceParser = (content, context) => {
  const source = createSource(context);
  const batch: NormalizedBatch = {
    source,
    sessions: [],
    turns: [],
    usage: [],
    toolCalls: [],
    issues: [],
  };
  const issue = (code: IssueCode, line: number) => {
    const row = createIssue(source, code, String(line), context.ingestedAt);
    if (!batch.issues.some((existing) => existing.id === row.id)) batch.issues.push(row);
  };
  const finish = () => {
    batch.issues.sort((a, b) => Number(a.location) - Number(b.location));
    return NormalizedBatchSchema.parse(batch);
  };
  const records: { data: ObjectRecord; line: number }[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push({ data: object(JSON.parse(line)), line: index + 1 });
    } catch {
      issue("invalid_json", index + 1);
    }
  }
  const first = records[0];
  const header = first?.data;
  if (header?.type !== "session" || header.version !== 3) {
    issue("unsupported_format", first?.line ?? 1);
    return finish();
  }
  const nativeSession = text(header.id);
  const started = iso(header.timestamp);
  if (!nativeSession || !started) {
    issue(!nativeSession ? "invalid_record" : "missing_timestamp", first?.line ?? 1);
    return finish();
  }
  const id = (kind: "turn" | "tool", ...parts: string[]) =>
    recordId(source.id, kind, JSON.stringify([nativeSession, ...parts]));
  const sessionId = piSessionId(source.id, nativeSession);
  batch.sessions.push({
    id: sessionId,
    source_id: source.id,
    agent: source.agent,
    cwd: typeof header.cwd === "string" ? header.cwd : null,
    repo: null,
    branch: null,
    started_at: started,
    ended_at: null,
    title: null,
    format_version: "3",
    parent_session_id: null,
  });
  const events = new Map<string, Event>();
  for (const { data, line } of records.slice(1)) {
    const eventId = text(data.id);
    if (
      !eventId ||
      !text(data.type) ||
      data.type === "session" ||
      (data.parentId !== null && !text(data.parentId))
    ) {
      issue("invalid_record", line);
      continue;
    }
    if (events.has(eventId)) {
      issue(USAGE_TYPES.includes(String(data.type)) ? "duplicate_usage" : "invalid_record", line);
      continue;
    }
    if (!iso(data.timestamp)) issue("missing_timestamp", line);
    events.set(eventId, { data, id: eventId, parent: text(data.parentId), line });
  }
  const parent = (event: Event) => (event.parent ? events.get(event.parent) : undefined);
  for (const event of events.values()) {
    if (event.parent && event.parent !== nativeSession && !events.has(event.parent)) {
      issue("invalid_record", event.line);
    }
  }
  const profiles = new Map<string, ProfileSnapshot>();
  /** Undefined: not a family entry, so the inherited binding stays. */
  const binding = (data: ObjectRecord): string | null | undefined => {
    if (data.type !== "custom" || typeof data.customType !== "string") return undefined;
    if (!data.customType.startsWith(SESSION_PROFILE_FAMILY)) return undefined;
    const payload = object(data.data);
    if (data.customType !== SESSION_PROFILE_CUSTOM_TYPE || payload.kind !== "bind") return null;
    const seenAt = new Date(iso(data.timestamp) ?? started).toISOString();
    const snapshot = profileSnapshot(payload.name, payload.modelProfiles, seenAt);
    if (!snapshot) return null;
    const seen = profiles.get(snapshot.hash);
    if (!seen || snapshot.first_seen_at < seen.first_seen_at) profiles.set(snapshot.hash, snapshot);
    return snapshot.hash;
  };
  const states = new Map<string, State>();
  const stateFor = (event: Event): State => {
    const path: Event[] = [];
    const seen = new Set<string>();
    let cursor: Event | undefined = event;
    while (cursor && !states.has(cursor.id)) {
      if (seen.has(cursor.id)) {
        issue("invalid_record", event.line);
        break;
      }
      seen.add(cursor.id);
      path.push(cursor);
      cursor = parent(cursor);
    }
    let state: State = (cursor && states.get(cursor.id)) || {
      model: null,
      provider: null,
      effort: null,
      profile: null,
    };
    for (const node of path.reverse()) {
      const data = node.data;
      const bound = binding(data);
      const message = data.type === "message" ? object(data.message) : {};
      state = {
        model: text(data.type === "model_change" ? data.modelId : message.model) ?? state.model,
        provider:
          text(data.type === "model_change" ? data.provider : message.provider) ?? state.provider,
        effort:
          text(
            data.type === "thinking_level_change" ? data.thinkingLevel : message.thinkingLevel,
          ) ?? state.effort,
        profile: bound === undefined ? state.profile : bound,
      };
      states.set(node.id, state);
    }
    return state;
  };
  const turns = new Map<string, NormalizedBatch["turns"][number]>();
  for (const event of events.values()) {
    const { data, line } = event;
    if (!USAGE_TYPES.includes(String(data.type))) continue;
    const message = object(data.message);
    if (
      data.type === "message" &&
      (typeof message.role !== "string" ||
        !["user", "assistant", "toolResult"].includes(message.role))
    ) {
      issue("invalid_record", line);
      continue;
    }
    const ts = iso(data.timestamp);
    if (!ts) {
      issue("missing_timestamp", line);
      continue;
    }
    // Usage entries carry their own attribution and never change the inherited state.
    const inherited = stateFor(event);
    const state =
      data.type === "usage"
        ? { model: text(data.model), provider: text(data.provider), effort: null }
        : { model: inherited.model, provider: inherited.provider, effort: inherited.effort };
    const turn = {
      id: id("turn", event.id),
      session_id: sessionId,
      idx: batch.turns.length,
      role: String(data.type === "message" ? message.role : data.type),
      ts,
      ...state,
      subscription_id: null,
      is_compaction: data.type === "compaction",
    };
    batch.turns.push(turn);
    turns.set(event.id, turn);
    if (inherited.profile) {
      batch.profileBindings ??= [];
      batch.profileBindings.push({ turn_id: turn.id, profile_hash: inherited.profile });
    }
    if (data.type === "message" && message.role !== "assistant") continue;
    if (data.type === "compaction" && data.usage === undefined) continue;
    const raw = object(data.type === "message" ? message.usage : data.usage);
    const metrics = tokenSchema.safeParse({
      input_tokens: raw.input,
      output_tokens: raw.output,
      cache_read_tokens: raw.cacheRead,
      cache_write_tokens: raw.cacheWrite,
    });
    if (
      !metrics.success ||
      raw.totalTokens !==
        Number(raw.input) + Number(raw.output) + Number(raw.cacheRead) + Number(raw.cacheWrite)
    ) {
      issue("missing_usage", line);
      continue;
    }
    const cost = object(raw.cost).total;
    const reported = UsageSchema.shape.reported_cost_usd.safeParse(cost ?? null);
    if (!reported.success) issue("invalid_record", line);
    batch.usage.push({
      turn_id: turn.id,
      ...metrics.data,
      reported_cost_usd: reported.success ? reported.data : null,
      computed_cost_usd:
        state.provider && state.model
          ? calculateCost(metrics.data, state.provider, state.model, ts, context.pricing)
          : null,
    });
  }
  if (profiles.size > 0) batch.profiles = [...profiles.values()];
  // Join through ancestry, not a global tool-id map that could cross branches.
  for (const event of events.values()) {
    const message = object(event.data.message);
    if (event.data.type !== "message" || message.role !== "toolResult" || !turns.has(event.id))
      continue;
    if (!text(message.toolCallId) || typeof message.isError !== "boolean") {
      issue("invalid_record", event.line);
      continue;
    }
    const seen = new Set<string>();
    let cursor = parent(event);
    let matched = false;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const origin = object(cursor.data.message);
      const calls = Array.isArray(origin.content) ? origin.content : [];
      const call = calls
        .map(object)
        .find(
          (part) => part.type === "toolCall" && part.id === message.toolCallId && text(part.name),
        );
      const turn = turns.get(cursor.id);
      if (cursor.data.type === "message" && origin.role === "assistant" && call && turn) {
        const toolId = id("tool", cursor.id, String(call.id));
        if (!batch.toolCalls.some((row) => row.id === toolId)) {
          const elapsed = Date.parse(String(event.data.timestamp)) - Date.parse(turn.ts);
          const duration =
            typeof message.durationMs === "number" &&
            Number.isSafeInteger(message.durationMs) &&
            message.durationMs >= 0
              ? message.durationMs
              : Number.isSafeInteger(elapsed) && elapsed >= 0
                ? elapsed
                : null;
          batch.toolCalls.push({
            id: toolId,
            turn_id: turn.id,
            tool: String(call.name),
            duration_ms: duration,
            status: message.isError ? "error" : "ok",
          });
        }
        matched = true;
        break;
      }
      cursor = parent(cursor);
    }
    if (!matched) issue("invalid_record", event.line);
  }
  return finish();
};
