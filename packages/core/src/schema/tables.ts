import { z } from "zod";

// Row contracts for the normalized schema (spec §4). Column names mirror migrations/*.sql;
// a test fails if a Zod shape and its SQL table drift apart.

const id = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();
const tokens = z.number().int().nonnegative();
const usd = z.number().nonnegative();
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

export const WindowKindSchema = z.enum(["five_hours", "weekly", "monthly"]);
export type WindowKind = z.infer<typeof WindowKindSchema>;

export const SourceSchema = z.object({
  id,
  agent: z.string().min(1),
  path: z.string().min(1),
  adapter_version: z.string().min(1),
  last_ingested_at: nullable(timestamp),
});

export const SessionSchema = z.object({
  id,
  source_id: id,
  agent: z.string().min(1),
  cwd: nullable(z.string()),
  repo: nullable(z.string()),
  branch: nullable(z.string()),
  started_at: timestamp,
  ended_at: nullable(timestamp),
  title: nullable(z.string()),
  format_version: z.string().min(1),
  parent_session_id: nullable(id),
});

export const TurnSchema = z.object({
  id,
  session_id: id,
  idx: z.number().int().nonnegative(),
  role: z.string().min(1),
  ts: timestamp,
  model: nullable(z.string()),
  provider: nullable(z.string()),
  effort: nullable(z.string()),
  subscription_id: nullable(id),
  is_compaction: z.boolean(),
});

export const UsageSchema = z.object({
  turn_id: id,
  input_tokens: tokens,
  output_tokens: tokens,
  cache_read_tokens: tokens,
  cache_write_tokens: tokens,
  reported_cost_usd: nullable(usd),
  computed_cost_usd: nullable(usd),
});

export const ToolCallSchema = z.object({
  id,
  turn_id: id,
  tool: z.string().min(1),
  duration_ms: nullable(z.number().int().nonnegative()),
  status: z.enum(["ok", "error"]),
});

export const SubagentRunSchema = z.object({
  id,
  parent_session_id: id,
  role: z.string().min(1),
  model: nullable(z.string()),
  provider: nullable(z.string()),
  effort: nullable(z.string()),
  started_at: nullable(timestamp),
  duration_ms: nullable(z.number().int().nonnegative()),
  input_tokens: tokens,
  output_tokens: tokens,
  cache_read_tokens: tokens,
  cache_write_tokens: tokens,
  reported_cost_usd: nullable(usd),
  computed_cost_usd: nullable(usd),
});

export const ProfileSchema = z.object({
  hash: id,
  name: z.string().min(1),
  definition: z.unknown(),
  first_seen_at: timestamp,
});

export const TurnProfileSchema = z.object({
  turn_id: id,
  profile_hash: id,
  attribution: z.enum(["exact", "estimated"]),
});

export const PricingRowSchema = z.object({
  model: z.string().min(1),
  provider: z.string().min(1),
  valid_from: date,
  valid_to: nullable(date),
  input_per_mtok: usd,
  output_per_mtok: usd,
  cache_read_per_mtok: usd,
  cache_write_per_mtok: usd,
});

export const SubscriptionSchema = z.object({
  id,
  plan_id: id,
  provider: z.string().min(1),
  label: z.string().min(1),
  started_at: nullable(date),
  ended_at: nullable(date),
});

export const QuotaWindowSchema = z.object({
  id,
  subscription_id: id,
  kind: WindowKindSchema,
  starts_at: timestamp,
  ends_at: timestamp,
  used_tokens: tokens,
  used_usd: usd,
  limit_usd: nullable(usd),
  estimated_pct: nullable(z.number().nonnegative()),
});

export const CalibrationSchema = z.object({
  id,
  subscription_id: id,
  window_kind: WindowKindSchema,
  observed_at: timestamp,
  observed_pct: z.number().nonnegative(),
  note: nullable(z.string()),
});

export const CommitSchema = z.object({
  repo: z.string().min(1),
  sha: z.string().regex(/^[0-9a-f]{7,64}$/),
  authored_at: timestamp,
  author: nullable(z.string()),
  message: nullable(z.string()),
  additions: nullable(z.number().int().nonnegative()),
  deletions: nullable(z.number().int().nonnegative()),
});

export const IngestIssueSchema = z.object({
  id,
  source_id: nullable(id),
  path: nullable(z.string()),
  location: nullable(z.string()),
  severity: z.enum(["warning", "error", "critical"]),
  code: z.string().min(1),
  message: z.string().min(1),
  created_at: timestamp,
});

export const TABLE_SCHEMAS = {
  sources: SourceSchema,
  sessions: SessionSchema,
  turns: TurnSchema,
  usage: UsageSchema,
  tool_calls: ToolCallSchema,
  subagent_runs: SubagentRunSchema,
  profiles: ProfileSchema,
  turn_profile: TurnProfileSchema,
  pricing: PricingRowSchema,
  subscriptions: SubscriptionSchema,
  quota_windows: QuotaWindowSchema,
  calibrations: CalibrationSchema,
  commits: CommitSchema,
  ingest_issues: IngestIssueSchema,
} as const;

export type TableName = keyof typeof TABLE_SCHEMAS;
export type Row<T extends TableName> = z.infer<(typeof TABLE_SCHEMAS)[T]>;
