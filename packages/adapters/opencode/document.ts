// Canonical metrics-only projection of one OpenCode session (odd/tasks/phase-2-explorer.md L10).
// The reader builds it from SQLite rows or legacy JSON files; the parser only ever sees this.
// Content (text, prompts, titles, tool input/output, errors, summaries) is never projected.

export const OPENCODE_DOCUMENT_FORMAT = 1;
/** Native OpenCode ids are `ses_…`/`msg_…`; anything else could escape the virtual session path. */
export const OPENCODE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface OpenCodeToolPart {
  type: "tool";
  callID: string | null;
  tool: string | null;
  status: string | null;
  start: number | null;
  end: number | null;
}
export interface OpenCodeCompactionPart {
  type: "compaction";
}
export type OpenCodePart = OpenCodeToolPart | OpenCodeCompactionPart;
export interface OpenCodeTokens {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cache: { read: number | null; write: number | null };
}
export interface OpenCodeMessage {
  id: string;
  role: string | null;
  time: { created: number | null; completed: number | null };
  modelID: string | null;
  providerID: string | null;
  variant: string | null;
  mode: string | null;
  summary: boolean | null;
  cost: number | null;
  tokens: OpenCodeTokens | null;
  /** Only tool and compaction parts; `null` marks an unreadable part. */
  parts: (OpenCodePart | null)[];
}
export interface OpenCodeSessionInfo {
  id: string;
  parentId: string | null;
  directory: string | null;
  version: string | null;
  created: number | null;
  updated: number | null;
}
/** Issue locations count entries in document order: 1 is the session, then each message
 * followed by its parts. `null` messages mark unreadable records.
 */
export interface OpenCodeDocument {
  format: typeof OPENCODE_DOCUMENT_FORMAT;
  origin: "sqlite" | "legacy";
  session: OpenCodeSessionInfo;
  messages: (OpenCodeMessage | null)[];
}

type ObjectRecord = Record<string, unknown>;
export const object = (value: unknown): ObjectRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectRecord)
    : {};
const string = (value: unknown) => (typeof value === "string" ? value : null);
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Keeps only metric fields; a user message `summary` object (title/body) is dropped. */
export function projectMessage(id: string, data: unknown): OpenCodeMessage {
  const raw = object(data);
  const time = object(raw.time);
  const tokens = raw.tokens !== null && typeof raw.tokens === "object" ? object(raw.tokens) : null;
  const cache = object(tokens?.cache);
  return {
    id,
    role: string(raw.role),
    time: { created: number(time.created), completed: number(time.completed) },
    modelID: string(raw.modelID),
    providerID: string(raw.providerID),
    variant: string(raw.variant),
    mode: string(raw.mode),
    summary: typeof raw.summary === "boolean" ? raw.summary : null,
    cost: number(raw.cost),
    tokens: tokens && {
      input: number(tokens.input),
      output: number(tokens.output),
      reasoning: number(tokens.reasoning),
      cache: { read: number(cache.read), write: number(cache.write) },
    },
    parts: [],
  };
}

/** Tool and compaction parts only; step-finish usage repeats the message usage (L9). */
export function projectPart(data: unknown): OpenCodePart | undefined {
  const raw = object(data);
  if (raw.type === "compaction") return { type: "compaction" };
  if (raw.type !== "tool") return undefined;
  const state = object(raw.state);
  const time = object(state.time);
  return {
    type: "tool",
    callID: string(raw.callID),
    tool: string(raw.tool),
    status: string(state.status),
    start: number(time.start),
    end: number(time.end),
  };
}

/** Stable order: creation time, then id; entries without a time go last. */
export function compareByTime(
  a: { time: number | null; id: string },
  b: { time: number | null; id: string },
): number {
  if (a.time !== b.time) {
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time - b.time;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
