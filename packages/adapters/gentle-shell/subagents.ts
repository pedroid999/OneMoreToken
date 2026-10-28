import {
  createIssue,
  createSource,
  type NormalizedBatch,
  NormalizedBatchSchema,
  type SourceParser,
  sourceFileId,
} from "@omt/core";
import { parsePi, piSessionId } from "../pi";

export const GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION = "gentle-shell-subagent/1";
/** Marks child transcripts, including those without a task record (role unknown, spec §6.1). */
export const GENTLE_SHELL_SUBAGENT_FORMAT = "pi-subagent/3";
const DOCUMENT_FORMAT = "omt-gentle-subagent/1";
const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SESSION_FILE = /^[^/\\]+\.jsonl$/;

/** The only task record keys ever kept; prompt, result, label, cwd and thread are dropped. */
export interface GentleTaskRecord {
  id: string;
  agent: string;
  parentSessionId: string;
  model: string | null;
  thinking: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}
type ObjectRecord = Record<string, unknown>;
const object = (value: unknown): ObjectRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectRecord)
    : {};
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
const epoch = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

function toTask(raw: ObjectRecord): GentleTaskRecord | null {
  const id = text(raw.id);
  const agent = text(raw.agent);
  const parentSessionId = text(raw.parentSessionId);
  const createdAt = epoch(raw.createdAt);
  if (!id || !agent || !parentSessionId || !NATIVE_ID.test(parentSessionId) || createdAt === null)
    return null;
  return {
    id,
    agent,
    parentSessionId,
    model: text(raw.model),
    thinking: text(raw.thinking),
    createdAt,
    startedAt: epoch(raw.startedAt),
    endedAt: epoch(raw.endedAt),
  };
}

/** Reads `gentle-agents/tasks/*.json` metadata (D4, L9). Returns the linked transcript file name. */
export function readGentleTaskRecord(
  content: string,
): { sessionFile: string; task: GentleTaskRecord } | null {
  let raw: ObjectRecord;
  try {
    raw = object(object(JSON.parse(content)).task);
  } catch {
    return null;
  }
  const task = toTask(raw);
  const sessionFile = text(raw.sessionPath)?.split(/[/\\]/).pop() ?? null;
  if (!task || !sessionFile || !SESSION_FILE.test(sessionFile)) return null;
  return { sessionFile, task };
}

/** `provider/model` as recorded by gentle-shell; the model id may contain further slashes. */
function splitModel(value: string | null): [string | null, string | null] {
  const slash = value?.indexOf("/") ?? -1;
  if (!value || slash <= 0 || slash === value.length - 1) return [null, value];
  return [value.slice(0, slash), value.slice(slash + 1)];
}

const byCreation = (a: GentleTaskRecord, b: GentleTaskRecord) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** Canonical virtual source content: its hash changes when the transcript, a task record or the
 * parent resolution changes, so the core checkpoint stays incremental and idempotent.
 * `parentPaths` maps native parent ids to their gentle-shell transcript paths.
 */
export function createGentleSubagentDocument(input: {
  session: string;
  tasks: readonly GentleTaskRecord[];
  parentPaths: Readonly<Record<string, string>>;
}): string {
  const tasks = [...input.tasks].sort(byCreation);
  const parentPaths = Object.fromEntries(
    [...new Set(tasks.map((task) => task.parentSessionId))]
      .sort()
      .flatMap((id) => (input.parentPaths[id] ? [[id, input.parentPaths[id]]] : [])),
  );
  return JSON.stringify({ format: DOCUMENT_FORMAT, tasks, parentPaths, session: input.session });
}

const sum = (values: (number | null)[]) => {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Number(known.reduce((a, b) => a + b, 0).toPrecision(12)) : null;
};

/** Child transcripts reuse the Pi parser. The earliest task record created the session and gives
 * role, model and effort; later records (resumed tasks) only extend the duration. Without a task
 * record or a resolvable parent the child keeps no parent and no run.
 */
export const parseGentleShellSubagent: SourceParser = (content, context) => {
  let document: ObjectRecord;
  try {
    document = object(JSON.parse(content));
  } catch {
    document = { format: null, invalid: true };
  }
  if (document.format !== DOCUMENT_FORMAT || typeof document.session !== "string") {
    const source = createSource(context);
    const empty: NormalizedBatch = {
      source,
      sessions: [],
      turns: [],
      usage: [],
      toolCalls: [],
      issues: [
        createIssue(
          source,
          document.invalid ? "invalid_json" : "unsupported_format",
          "1",
          context.ingestedAt,
        ),
      ],
    };
    return NormalizedBatchSchema.parse(empty);
  }
  const batch = parsePi(document.session, context);
  const session = batch.sessions[0];
  if (!session) return batch;
  session.format_version = GENTLE_SHELL_SUBAGENT_FORMAT;
  const tasks = (Array.isArray(document.tasks) ? document.tasks : [])
    .map((entry) => toTask(object(entry)))
    .filter((task): task is GentleTaskRecord => task !== null)
    .sort(byCreation);
  const primary = tasks[0];
  const parentPath = primary ? text(object(document.parentPaths)[primary.parentSessionId]) : null;
  batch.subagentRuns = [];
  if (!primary || !parentPath) return NormalizedBatchSchema.parse(batch);
  const parent = piSessionId(sourceFileId(context.agent, parentPath), primary.parentSessionId);
  session.parent_session_id = parent;
  const [provider, model] = splitModel(primary.model);
  const started = primary.startedAt ?? primary.createdAt;
  const ends = tasks.map((task) => task.endedAt).filter((end): end is number => end !== null);
  const ended = ends.length > 0 ? Math.max(...ends) : null;
  const usage = batch.usage;
  batch.subagentRuns.push({
    id: session.id,
    parent_session_id: parent,
    role: primary.agent,
    model,
    provider,
    effort: primary.thinking,
    started_at: new Date(started).toISOString(),
    duration_ms: ended !== null && ended >= started ? ended - started : null,
    input_tokens: usage.reduce((total, row) => total + row.input_tokens, 0),
    output_tokens: usage.reduce((total, row) => total + row.output_tokens, 0),
    cache_read_tokens: usage.reduce((total, row) => total + row.cache_read_tokens, 0),
    cache_write_tokens: usage.reduce((total, row) => total + row.cache_write_tokens, 0),
    reported_cost_usd: sum(usage.map((row) => row.reported_cost_usd)),
    computed_cost_usd: sum(usage.map((row) => row.computed_cost_usd)),
  });
  return NormalizedBatchSchema.parse(batch);
};
