import {
  type Database,
  hashContent,
  loadPricing,
  type PricingFile,
  PricingFileSchema,
  type SqlParams,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { IngestAgent } from "../ingest-options";
import type { SummaryPeriod } from "../summary/contract";
import { summaryPeriod } from "../summary/service";
import type {
  SessionChild,
  SessionDetail,
  SessionItem,
  SessionList,
  SessionPricing,
  SessionStats,
  SessionToolCall,
  SessionTurn,
} from "./contract";

export const DEFAULT_SESSIONS_LIMIT = 100;
export const MAX_SESSIONS_LIMIT = 500;
const AGENTS: readonly IngestAgent[] = ["claude-code", "gentle-shell", "pi", "opencode"];
/** Stored session ids are `recordId(sourceId, "session", nativeId)`: two sha256 hex digests. */
const SESSION_ID = /^[0-9a-f]{64}:session:[0-9a-f]{64}$/;

export interface SessionsQuery {
  period: SummaryPeriod;
  agent?: IngestAgent;
  limit: number;
}

/** Same period rules as the Summary; agent and limit appear at most once. */
export function parseSessionsQuery(
  params: URLSearchParams,
  now = Date.now(),
): SessionsQuery | null {
  const period = summaryPeriod(params, now);
  if (!period) return null;
  const query: SessionsQuery = { period, limit: DEFAULT_SESSIONS_LIMIT };
  const agents = params.getAll("agent");
  if (agents.length > 1) return null;
  if (agents.length === 1) {
    const agent = AGENTS.find((known) => known === agents[0]);
    if (!agent) return null;
    query.agent = agent;
  }
  const limits = params.getAll("limit");
  if (limits.length > 1) return null;
  if (limits.length === 1) {
    if (!/^[1-9]\d{0,3}$/.test(limits[0] ?? "")) return null;
    query.limit = Number(limits[0]);
    if (query.limit > MAX_SESSIONS_LIMIT) return null;
  }
  return query;
}

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id);
}

function numeric(value: unknown, integer = true): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("unsafe sessions");
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(number))
  ) {
    throw new Error("unsafe sessions");
  }
  return number;
}
const optional = (value: unknown, integer = true) =>
  value === null || value === undefined ? null : numeric(value, integer);
const text = (value: unknown) => (typeof value === "string" ? value : null);
function required(value: unknown): string {
  if (typeof value !== "string") throw new Error("unsafe sessions");
  return value;
}

/** Last path segment only (POSIX or Windows separators): the full path is private. */
function basename(cwd: unknown): string | null {
  if (typeof cwd !== "string") return null;
  return (
    cwd
      .split(/[\\/]+/)
      .filter(Boolean)
      .at(-1) ?? null
  );
}

const iso = (column: string) => `strftime(${column} AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ')`;

/** Per-session aggregates; `where` only references `t`/`s` and bound placeholders. */
function statsSql(where: string, hash: string): string {
  return `SELECT t.session_id,
      count(*) AS turns, count(u.turn_id) AS usage_turns,
      coalesce(sum(u.input_tokens), 0) AS input, coalesce(sum(u.output_tokens), 0) AS output,
      coalesce(sum(u.cache_read_tokens), 0) AS cache_read,
      coalesce(sum(u.cache_write_tokens), 0) AS cache_write,
      sum(u.reported_cost_usd) AS reported, count(u.reported_cost_usd) AS reported_known,
      sum(CASE WHEN c.pricing_hash = ${hash} THEN u.computed_cost_usd END) AS computed,
      count(CASE WHEN c.pricing_hash = ${hash} THEN u.computed_cost_usd END) AS computed_known,
      count(CASE WHEN t.is_compaction THEN 1 END) AS compactions
    FROM turns t LEFT JOIN usage u ON u.turn_id = t.id
    JOIN sessions s ON s.id = t.session_id
    LEFT JOIN ingest_checkpoints c ON c.source_id = s.source_id
    WHERE ${where}
    GROUP BY t.session_id`;
}

function stats(row: Record<string, unknown> | undefined): SessionStats {
  const usageTurns = numeric(row?.usage_turns ?? 0);
  const tokens = {
    input: numeric(row?.input ?? 0),
    output: numeric(row?.output ?? 0),
    cacheRead: numeric(row?.cache_read ?? 0),
    cacheWrite: numeric(row?.cache_write ?? 0),
    total: 0,
  };
  tokens.total = numeric(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite);
  const cost = (key: "reported" | "computed") => {
    const known = numeric(row?.[`${key}_known`] ?? 0);
    return {
      usd: known ? numeric(row?.[key], false) : null,
      known,
      unknown: numeric(usageTurns - known),
    };
  };
  return {
    turns: numeric(row?.turns ?? 0),
    usageTurns,
    tokens,
    costs: { reported: cost("reported"), computed: cost("computed") },
  };
}

const SESSION_COLUMNS = `s.id, s.agent, s.cwd, s.branch, s.parent_session_id,
  ${iso("s.started_at")} AS started_at, ${iso("s.ended_at")} AS ended_at,
  (SELECT count(*) FROM sessions k WHERE k.parent_session_id = s.id) AS child_count`;

function item(row: Record<string, unknown>, statsRow: Record<string, unknown> | undefined) {
  return {
    id: required(row.id),
    agent: required(row.agent),
    cwd: basename(row.cwd),
    branch: text(row.branch),
    startedAt: required(row.started_at),
    endedAt: text(row.ended_at),
    parentId: text(row.parent_session_id),
    ...stats(statsRow),
    compactions: numeric(statsRow?.compactions ?? 0),
    children: numeric(row.child_count),
  } satisfies SessionItem;
}

function catalog(pricing?: PricingFile) {
  const parsed = PricingFileSchema.parse(pricing ?? loadPricing());
  const info: SessionPricing = {
    basis: parsed.basis ?? "historical",
    observedAt: parsed.observedAt ?? null,
  };
  return { hash: hashContent(JSON.stringify(parsed)), info };
}

/** One queue operation: no reads inside an ingestion transaction. Never mutates data. */
export function readSessions(
  db: Database,
  query: SessionsQuery,
  pricing?: PricingFile,
): Promise<SessionList> {
  return withDatabase(db, async () => {
    const { hash, info } = catalog(pricing);
    const params: SqlParams = [query.period.from, query.period.to, hash];
    let where = "t.ts >= $1::TIMESTAMPTZ AND t.ts < $2::TIMESTAMPTZ";
    if (query.agent) {
      params.push(query.agent);
      where += ` AND s.agent = $${params.length}`;
    }
    // LIMIT is a parsed integer in [1, MAX_SESSIONS_LIMIT]; everything else is bound.
    const rows = await db.all(
      `WITH g AS (${statsSql(where, "$3")})
      SELECT ${SESSION_COLUMNS}, g.*
      FROM g JOIN sessions s ON s.id = g.session_id
      ORDER BY s.started_at DESC, s.id ASC
      LIMIT ${query.limit + 1}`,
      params,
    );
    return {
      period: query.period,
      sessions: rows.slice(0, query.limit).map((row) => item(row, row)),
      truncated: rows.length > query.limit,
      pricing: info,
    };
  });
}

/** Null when no stored session has this id. Callers validate the id with isSessionId first. */
export function readSession(
  db: Database,
  id: string,
  pricing?: PricingFile,
): Promise<SessionDetail | null> {
  return withDatabase(db, async () => {
    const { hash, info } = catalog(pricing);
    const [row] = await db.all(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = $1`, [id]);
    if (!row) return null;
    const [own] = await db.all(statsSql("t.session_id = $1", "$2"), [id, hash]);
    const turnRows = await db.all(
      `SELECT t.id, t.idx, t.role, ${iso("t.ts")} AS ts, t.model, t.provider, t.effort,
        t.is_compaction, u.turn_id IS NOT NULL AS has_usage,
        u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens,
        u.reported_cost_usd,
        CASE WHEN c.pricing_hash = $2 THEN u.computed_cost_usd END AS computed_cost_usd
      FROM turns t LEFT JOIN usage u ON u.turn_id = t.id
      JOIN sessions s ON s.id = t.session_id
      LEFT JOIN ingest_checkpoints c ON c.source_id = s.source_id
      WHERE t.session_id = $1
      ORDER BY t.idx ASC, t.id ASC`,
      [id, hash],
    );
    const tools = new Map<string, SessionToolCall[]>();
    for (const call of await db.all(
      `SELECT x.turn_id, x.tool, x.status, x.duration_ms
      FROM tool_calls x JOIN turns t ON t.id = x.turn_id
      WHERE t.session_id = $1 ORDER BY x.id`,
      [id],
    )) {
      const turnId = required(call.turn_id);
      const status = call.status === "error" ? "error" : "ok";
      const list = tools.get(turnId) ?? [];
      list.push({ tool: required(call.tool), status, durationMs: optional(call.duration_ms) });
      tools.set(turnId, list);
    }
    const turns = turnRows.map((turn): SessionTurn => {
      const tokens = turn.has_usage
        ? {
            input: numeric(turn.input_tokens),
            output: numeric(turn.output_tokens),
            cacheRead: numeric(turn.cache_read_tokens),
            cacheWrite: numeric(turn.cache_write_tokens),
          }
        : null;
      return {
        idx: numeric(turn.idx),
        role: required(turn.role),
        ts: required(turn.ts),
        model: text(turn.model),
        provider: text(turn.provider),
        effort: text(turn.effort),
        isCompaction: turn.is_compaction === true,
        tokens,
        contextTokens: tokens ? numeric(tokens.input + tokens.cacheRead + tokens.cacheWrite) : null,
        costs: {
          reported: optional(turn.reported_cost_usd, false),
          computed: optional(turn.computed_cost_usd, false),
        },
        tools: tools.get(required(turn.id)) ?? [],
      };
    });

    const parentId = text(row.parent_session_id);
    let parent: SessionDetail["parent"] = null;
    if (parentId) {
      const [stored] = await db.all("SELECT agent FROM sessions WHERE id = $1", [parentId]);
      parent = { id: parentId, agent: stored ? required(stored.agent) : null };
    }
    const childRows = await db.all(
      `SELECT s.id, s.agent, ${iso("s.started_at")} AS started_at
      FROM sessions s WHERE s.parent_session_id = $1 ORDER BY s.started_at ASC, s.id ASC`,
      [id],
    );
    const childStats = new Map(
      (await db.all(statsSql("s.parent_session_id = $1", "$2"), [id, hash])).map((stat) => [
        required(stat.session_id),
        stat,
      ]),
    );
    const children = childRows.map(
      (child): SessionChild => ({
        id: required(child.id),
        agent: required(child.agent),
        startedAt: required(child.started_at),
        ...stats(childStats.get(required(child.id))),
      }),
    );
    return { session: item(row, own), turns, parent, children, pricing: info };
  });
}
