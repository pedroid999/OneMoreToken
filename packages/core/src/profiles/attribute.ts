import { listValue } from "@duckdb/node-api";
import type { Database } from "../db/database";
import { type ProfileDefinition, ProfileDefinitionSchema } from "./snapshot";

/**
 * Role of the session `s` joined to its run `r` (`LEFT JOIN subagent_runs r ON r.id = s.id`), spec
 * §6.1, L12: parent gentle-shell sessions are the orchestrator, children take their run role, and a
 * child without a run (`pi-subagent/3`, or any session with a parent) is `unknown`, never the
 * orchestrator. Other agents have no gentle-shell roles.
 */
export const TURN_ROLE_SQL = `CASE
  WHEN s.agent IS DISTINCT FROM 'gentle-shell' THEN NULL
  WHEN r.id IS NOT NULL THEN r.role
  WHEN s.parent_session_id IS NOT NULL OR s.format_version = 'pi-subagent/3' THEN 'unknown'
  ELSE 'orchestrator'
END`;

interface Snapshot {
  hash: string;
  name: string;
  definition: ProfileDefinition;
  seen: number;
}
interface TurnRow {
  id: string;
  ts: number;
  route: string | null;
  effort: string | null;
  role: string | null;
  bound: string | null;
}
interface SessionTurns {
  agent: string;
  parent: string | null;
  started: number;
  turns: TurnRow[];
}

const ms = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("unsafe profile attribution");
  return number;
};
const text = (value: unknown) => (typeof value === "string" ? value : null);

/**
 * Rewrites `turn_profile` in full from the stored snapshots, bindings and turns (L10); derived data,
 * so running it twice changes nothing. Exact: the turn's own binding, else the binding in force in
 * its parent session when the child started. Estimated, gentle-shell only: the turn's role and
 * `provider/model` + effort match a single profile name; that name's matching snapshot in force at
 * the turn (latest `first_seen_at` not after it, else the earliest) wins. Ambiguous = unattributed.
 * The caller owns the writer queue.
 */
export async function recomputeProfileAttribution(
  db: Database,
): Promise<{ exact: number; estimated: number }> {
  const snapshots: Snapshot[] = (
    await db.all(
      `SELECT hash, name, CAST(definition AS VARCHAR) AS definition, epoch_ms(first_seen_at) AS seen
       FROM profiles ORDER BY first_seen_at, hash`,
    )
  ).flatMap((row) => {
    let raw: unknown;
    try {
      raw = JSON.parse(String(row.definition));
    } catch {
      return [];
    }
    const definition = ProfileDefinitionSchema.safeParse(raw);
    return definition.success
      ? [
          {
            hash: String(row.hash),
            name: String(row.name),
            definition: definition.data,
            seen: ms(row.seen),
          },
        ]
      : [];
  });
  const known = new Set(snapshots.map((snapshot) => snapshot.hash));
  const rows = await db.all(
    `SELECT t.id, t.session_id, epoch_ms(t.ts) AS ts, t.provider, t.model, t.effort,
       s.agent, s.parent_session_id, epoch_ms(s.started_at) AS started,
       ${TURN_ROLE_SQL} AS role, b.profile_hash AS bound
     FROM turns t JOIN sessions s ON s.id = t.session_id
     LEFT JOIN subagent_runs r ON r.id = s.id
     LEFT JOIN turn_profile_bindings b ON b.turn_id = t.id
     ORDER BY t.session_id, t.ts, t.idx, t.id`,
  );
  const sessions = new Map<string, SessionTurns>();
  for (const row of rows) {
    const id = String(row.session_id);
    let session = sessions.get(id);
    if (!session) {
      session = {
        agent: String(row.agent),
        parent: text(row.parent_session_id),
        started: ms(row.started),
        turns: [],
      };
      sessions.set(id, session);
    }
    const provider = text(row.provider);
    const model = text(row.model);
    const bound = text(row.bound);
    session.turns.push({
      id: String(row.id),
      ts: ms(row.ts),
      route: provider && model ? `${provider}/${model}` : null,
      effort: text(row.effort),
      role: text(row.role),
      bound: bound && known.has(bound) ? bound : null,
    });
  }

  // The binding a child inherits: its parent's state at the child's start (spec §6.2).
  const inheritedBy = new Map<string, string | null>();
  const inherited = (id: string, visiting = new Set<string>()): string | null => {
    if (inheritedBy.has(id)) return inheritedBy.get(id) ?? null;
    const session = sessions.get(id);
    const parent = session?.parent ? sessions.get(session.parent) : undefined;
    let state: string | null = null;
    if (session?.parent && parent && !visiting.has(id)) {
      visiting.add(id);
      const fallback = inherited(session.parent, visiting);
      state = fallback;
      for (const turn of parent.turns) {
        if (turn.ts > session.started) break;
        state = turn.bound ?? fallback;
      }
    }
    inheritedBy.set(id, state);
    return state;
  };

  const candidates = new Map<string, Snapshot[]>();
  const estimate = (turn: TurnRow): Snapshot | null => {
    if (!turn.role || turn.role === "unknown" || !turn.route) return null;
    const key = JSON.stringify([turn.role, turn.route, turn.effort]);
    let matching = candidates.get(key);
    if (!matching) {
      matching = snapshots.filter(({ definition }) => {
        const roles = definition.roles;
        const entry = turn.role && Object.hasOwn(roles, turn.role) ? roles[turn.role] : undefined;
        return (
          entry?.model === turn.route &&
          (entry.thinking === undefined || entry.thinking === turn.effort)
        );
      });
      candidates.set(key, matching);
    }
    if (new Set(matching.map((snapshot) => snapshot.name)).size !== 1) return null;
    const inForce = matching.filter((snapshot) => snapshot.seen <= turn.ts);
    return inForce.at(-1) ?? matching[0] ?? null;
  };

  const ids: string[] = [];
  const hashes: string[] = [];
  const attributions: string[] = [];
  const counts = { exact: 0, estimated: 0 };
  for (const [id, session] of sessions) {
    for (const turn of session.turns) {
      const exact = turn.bound ?? inherited(id);
      const estimated = exact || session.agent !== "gentle-shell" ? null : estimate(turn);
      const hash = exact ?? estimated?.hash;
      if (!hash) continue;
      const attribution = exact ? "exact" : "estimated";
      ids.push(turn.id);
      hashes.push(hash);
      attributions.push(attribution);
      counts[attribution]++;
    }
  }

  await db.run("BEGIN TRANSACTION");
  try {
    await db.run("DELETE FROM turn_profile");
    if (ids.length > 0) {
      await db.run(
        `INSERT INTO turn_profile (turn_id, profile_hash, attribution)
         SELECT unnest($1::VARCHAR[]), unnest($2::VARCHAR[]), unnest($3::VARCHAR[])`,
        [listValue(ids), listValue(hashes), listValue(attributions)],
      );
    }
    await db.run("COMMIT");
  } catch (error) {
    try {
      await db.run("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
  return counts;
}
