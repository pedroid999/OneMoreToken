import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import type { PricingFile } from "../data/files";
import { ProfileDefinitionSchema, profileHash } from "../profiles/snapshot";
import {
  IngestIssueSchema,
  ProfileSchema,
  type Row,
  SessionSchema,
  SourceSchema,
  SubagentRunSchema,
  ToolCallSchema,
  TurnProfileBindingSchema,
  TurnSchema,
  UsageSchema,
} from "../schema/tables";

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Discovery supplies an absolute path; no filesystem access or realpath resolution occurs here. */
export function sourceFileId(agent: string, path: string): string {
  return hashContent(JSON.stringify([agent, normalize(path)]));
}

export function recordId(
  sourceId: string,
  kind: "session" | "turn" | "tool" | "issue",
  nativeId: string,
): string {
  return `${sourceId}:${kind}:${hashContent(nativeId)}`;
}

export interface ParseContext {
  agent: string;
  path: string;
  adapterVersion: string;
  ingestedAt: string;
  pricing: PricingFile;
}

export function createSource(context: ParseContext): Row<"sources"> {
  return SourceSchema.parse({
    id: sourceFileId(context.agent, context.path),
    agent: context.agent,
    path: normalize(context.path),
    adapter_version: context.adapterVersion,
    last_ingested_at: context.ingestedAt,
  });
}

// Only fixed diagnostics may reach storage, never exception messages or source snippets (spec §10).
export const ISSUE_MESSAGES = {
  invalid_json: "Invalid JSON record",
  invalid_record: "Invalid session record",
  unsupported_format: "Unsupported session format",
  missing_usage: "Usage metrics unavailable",
  duplicate_usage: "Repeated usage record ignored",
  missing_timestamp: "Record timestamp unavailable",
} as const;
export type IssueCode = keyof typeof ISSUE_MESSAGES;

export function createIssue(
  source: Row<"sources">,
  code: IssueCode,
  location: string | null,
  createdAt: string,
): Row<"ingest_issues"> {
  return {
    id: recordId(source.id, "issue", JSON.stringify([code, location])),
    source_id: source.id,
    path: source.path,
    location,
    severity: "warning",
    code,
    message: ISSUE_MESSAGES[code],
    created_at: createdAt,
  };
}

export const NormalizedBatchSchema = z
  .strictObject({
    source: SourceSchema.strict(),
    sessions: z.array(SessionSchema.extend({ title: z.null() }).strict()),
    turns: z.array(TurnSchema.extend({ subscription_id: z.null() }).strict()),
    usage: z.array(UsageSchema.strict()),
    toolCalls: z.array(ToolCallSchema.strict()),
    issues: z.array(
      IngestIssueSchema.extend({ location: z.string().regex(/^\d+$/).nullable() }).strict(),
    ),
    /** Child-owned: one run per child session of this source, keyed by the child session id. */
    subagentRuns: z.array(SubagentRunSchema.strict()).optional(),
    /** Session profile snapshots bound in this source (spec §6.2); upserted, never deleted. */
    profiles: z
      .array(ProfileSchema.extend({ definition: ProfileDefinitionSchema }).strict())
      .optional(),
    /** Source-owned: the profile bound when each turn was recorded; unbound turns have no row. */
    profileBindings: z.array(TurnProfileBindingSchema.strict()).optional(),
  })
  .superRefine((batch, ctx) => {
    const { source } = batch;
    const reject = () =>
      ctx.addIssue({ code: "custom", message: "Invalid source snapshot integrity" });
    if (
      !isAbsolute(source.path) ||
      source.path !== normalize(source.path) ||
      source.id !== sourceFileId(source.agent, source.path) ||
      source.last_ingested_at === null
    ) {
      reject();
    }
    const unique = (ids: string[]) => {
      if (new Set(ids).size !== ids.length) reject();
      return new Set(ids);
    };
    const sessions = unique(batch.sessions.map((row) => row.id));
    const turns = unique(batch.turns.map((row) => row.id));
    unique(batch.usage.map((row) => row.turn_id));
    unique(batch.toolCalls.map((row) => row.id));
    unique(batch.issues.map((row) => row.id));
    unique((batch.subagentRuns ?? []).map((row) => row.id));
    const profiles = unique((batch.profiles ?? []).map((row) => row.hash));
    unique((batch.profileBindings ?? []).map((row) => row.turn_id));
    for (const row of batch.profiles ?? []) {
      if (row.hash !== profileHash(row.definition) || row.name !== row.definition.name) reject();
    }
    for (const row of batch.profileBindings ?? []) {
      if (!turns.has(row.turn_id) || !profiles.has(row.profile_hash)) reject();
    }
    for (const row of batch.sessions) {
      if (
        !row.id.startsWith(`${source.id}:session:`) ||
        row.source_id !== source.id ||
        row.agent !== source.agent
      ) {
        reject();
      }
    }
    for (const row of batch.turns) {
      if (!row.id.startsWith(`${source.id}:turn:`) || !sessions.has(row.session_id)) reject();
    }
    for (const row of batch.usage) if (!turns.has(row.turn_id)) reject();
    for (const row of batch.subagentRuns ?? []) {
      const child = batch.sessions.find((session) => session.id === row.id);
      if (!child || child.parent_session_id !== row.parent_session_id) reject();
    }
    for (const row of batch.toolCalls) {
      if (!row.id.startsWith(`${source.id}:tool:`) || !turns.has(row.turn_id)) reject();
    }
    for (const row of batch.issues) {
      const code = row.code as IssueCode;
      if (
        !Object.hasOwn(ISSUE_MESSAGES, code) ||
        row.message !== ISSUE_MESSAGES[code] ||
        row.source_id !== source.id ||
        row.path !== source.path ||
        row.id !== recordId(source.id, "issue", JSON.stringify([code, row.location]))
      ) {
        reject();
      }
    }
  });

export type NormalizedBatch = z.infer<typeof NormalizedBatchSchema>;
/** Pure whole-file parser: validate with NormalizedBatchSchema; catch corrupt records into safe issues.
 * Native ids must be qualified with recordId(source.id, kind, nativeId), including session ids
 * in turn/tool native ids when those ids are only session-local. Never emit message content,
 * titles, tool arguments/results, raw errors, or speculative profile/subagent attribution: profile
 * bindings are only those recorded by the agent itself.
 */
export type SourceParser = (content: string, context: ParseContext) => NormalizedBatch;
