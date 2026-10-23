import { dirname, join } from "node:path";
import {
  calculateCost,
  createIssue,
  createSource,
  type IssueCode,
  type NormalizedBatch,
  NormalizedBatchSchema,
  recordId,
  type SourceParser,
  sourceFileId,
  UsageSchema,
} from "@omt/core";
import {
  OPENCODE_DOCUMENT_FORMAT,
  OPENCODE_ID,
  type OpenCodeMessage,
  type OpenCodeSessionInfo,
  object,
} from "./document";

export const OPENCODE_ADAPTER_VERSION = "opencode/1";
const tokenSchema = UsageSchema.pick({
  input_tokens: true,
  output_tokens: true,
  cache_read_tokens: true,
  cache_write_tokens: true,
});
const iso = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const id = (value: unknown) =>
  typeof value === "string" && OPENCODE_ID.test(value) ? value : null;

/** Pure OpenCode metrics over one canonical session document (`./document`, spec §3, §4, §10).
 * The source path is the virtual `<data dir>/sessions/<sessionId>`, shared by both origins.
 * Usage comes only from assistant message tokens (reasoning billed as output); step-finish
 * parts never reach the document. The agent `mode` is not stored until roles exist (Phase 3).
 */
export const parseOpenCode: SourceParser = (content, context) => {
  const source = createSource(context);
  const batch: NormalizedBatch = {
    source,
    sessions: [],
    turns: [],
    usage: [],
    toolCalls: [],
    issues: [],
  };
  const issue = (code: IssueCode, location: number) => {
    const row = createIssue(source, code, String(location), context.ingestedAt);
    if (!batch.issues.some((existing) => existing.id === row.id)) batch.issues.push(row);
  };
  const finish = () => {
    batch.issues.sort((a, b) => Number(a.location) - Number(b.location));
    return NormalizedBatchSchema.parse(batch);
  };
  let document: Record<string, unknown>;
  try {
    document = object(JSON.parse(content));
  } catch {
    issue("invalid_json", 1);
    return finish();
  }
  const origin = document.origin;
  if (
    document.format !== OPENCODE_DOCUMENT_FORMAT ||
    (origin !== "sqlite" && origin !== "legacy") ||
    !Array.isArray(document.messages)
  ) {
    issue("unsupported_format", 1);
    return finish();
  }
  const info = object(document.session) as Partial<OpenCodeSessionInfo>;
  const nativeSession = id(info.id);
  const started = iso(info.created);
  if (!nativeSession || !started) {
    issue(nativeSession ? "missing_timestamp" : "invalid_record", 1);
    return finish();
  }
  let parent: string | null = null;
  if (info.parentId !== null && info.parentId !== undefined) {
    const parentId = id(info.parentId);
    if (parentId) {
      const parentSource = sourceFileId(context.agent, join(dirname(context.path), parentId));
      parent = recordId(parentSource, "session", parentId);
    } else issue("invalid_record", 1);
  }
  const sessionId = recordId(source.id, "session", nativeSession);
  batch.sessions.push({
    id: sessionId,
    source_id: source.id,
    agent: source.agent,
    cwd: typeof info.directory === "string" ? info.directory : null,
    repo: null,
    branch: null,
    started_at: started,
    ended_at: iso(info.updated),
    title: null,
    format_version: `opencode-${origin}/${typeof info.version === "string" && info.version ? info.version : "unknown"}`,
    parent_session_id: parent,
  });
  let location = 1;
  const seen = new Set<string>();
  for (const entry of document.messages as unknown[]) {
    const line = ++location;
    if (entry === null) {
      issue("invalid_json", line);
      continue;
    }
    const message = object(entry) as Partial<OpenCodeMessage>;
    const parts: unknown[] = Array.isArray(message.parts) ? message.parts : [];
    const partLines = parts.map(() => ++location);
    const nativeMessage = id(message.id);
    if (
      !nativeMessage ||
      seen.has(nativeMessage) ||
      (message.role !== "user" && message.role !== "assistant")
    ) {
      issue(nativeMessage && seen.has(nativeMessage) ? "duplicate_usage" : "invalid_record", line);
      continue;
    }
    seen.add(nativeMessage);
    const ts = iso(object(message.time).created);
    if (!ts) {
      issue("missing_timestamp", line);
      continue;
    }
    const assistant = message.role === "assistant";
    const text = (value: unknown) =>
      assistant && typeof value === "string" && value.length > 0 ? value : null;
    const turn = {
      id: recordId(source.id, "turn", nativeMessage),
      session_id: sessionId,
      idx: batch.turns.length,
      role: message.role,
      ts,
      model: text(message.modelID),
      provider: text(message.providerID),
      effort: text(message.variant),
      subscription_id: null,
      is_compaction: parts.some((part) => object(part).type === "compaction"),
    };
    batch.turns.push(turn);
    for (const [index, entry] of parts.entries()) {
      const partLine = partLines[index] ?? line;
      if (entry === null) {
        issue("invalid_json", partLine);
        continue;
      }
      const part = object(entry);
      if (part.type !== "tool" || (part.status !== "completed" && part.status !== "error"))
        continue;
      const call = typeof part.callID === "string" && part.callID ? part.callID : null;
      const tool = typeof part.tool === "string" && part.tool ? part.tool : null;
      const toolId = call && recordId(source.id, "tool", JSON.stringify([nativeMessage, call]));
      if (!toolId || !tool || batch.toolCalls.some((row) => row.id === toolId)) {
        issue("invalid_record", partLine);
        continue;
      }
      const elapsed = Number(part.end) - Number(part.start);
      batch.toolCalls.push({
        id: toolId,
        turn_id: turn.id,
        tool,
        duration_ms:
          typeof part.start === "number" && Number.isSafeInteger(elapsed) && elapsed >= 0
            ? elapsed
            : null,
        status: part.status === "completed" ? "ok" : "error",
      });
    }
    if (!assistant) continue;
    const tokens = object(message.tokens);
    const cache = object(tokens.cache);
    const reasoning = tokens.reasoning ?? 0;
    const metrics = tokenSchema.safeParse({
      input_tokens: tokens.input,
      output_tokens:
        typeof tokens.output === "number" && typeof reasoning === "number"
          ? tokens.output + reasoning
          : undefined,
      cache_read_tokens: cache.read,
      cache_write_tokens: cache.write,
    });
    if (
      !metrics.success ||
      typeof reasoning !== "number" ||
      !Number.isSafeInteger(reasoning) ||
      reasoning < 0
    ) {
      issue("missing_usage", line);
      continue;
    }
    const reported = UsageSchema.shape.reported_cost_usd.safeParse(message.cost ?? null);
    if (!reported.success) issue("invalid_record", line);
    batch.usage.push({
      turn_id: turn.id,
      ...metrics.data,
      reported_cost_usd: reported.success ? reported.data : null,
      computed_cost_usd:
        turn.provider && turn.model
          ? calculateCost(metrics.data, turn.provider, turn.model, ts, context.pricing)
          : null,
    });
  }
  return finish();
};
