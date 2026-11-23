import {
  CORRECTABLE_TASK_CLASSES,
  type CorrectableTaskClass,
  type Database,
  derivedTaskClassSql,
  TASK_CLASS_SOURCES,
  TASK_CLASSES,
  type TaskClass,
  type TaskClassSource,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import type { SessionTaskClass } from "./contract";

/** The body is one small field: `{ "taskClass": "feature" | "inline" | null }` (L3). */
export const MAX_TASK_CLASS_BYTES = 1024;

export interface TaskClassInput {
  taskClass: CorrectableTaskClass | null;
}

/** Strict body: exactly one `taskClass` key, one of the two correctable classes or null. */
export function parseTaskClassInput(input: unknown): TaskClassInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "taskClass") return null;
  const { taskClass: value } = input as { taskClass?: unknown };
  if (value === null) return { taskClass: null };
  const found = CORRECTABLE_TASK_CLASSES.find((known) => known === value);
  return found ? { taskClass: found } : null;
}

function taskClass(value: unknown): TaskClass {
  const found = TASK_CLASSES.find((known) => known === value);
  if (!found) throw new Error("unsafe task class");
  return found;
}
function source(value: unknown): TaskClassSource {
  const found = TASK_CLASS_SOURCES.find((known) => known === value);
  if (!found) throw new Error("unsafe task class");
  return found;
}

/**
 * Effective class: the correction wins over the derived class, and the payload always says which
 * one it is. Reads with the caller's connection: no query of its own outside the queue.
 */
export async function readSessionTaskClass(db: Database, id: string): Promise<SessionTaskClass> {
  const [row] = await db.all(
    `SELECT coalesce(stc.task_class, ${derivedTaskClassSql("s.id")}) AS value,
      CASE WHEN stc.task_class IS NULL THEN 'derived' ELSE 'corrected' END AS source
    FROM sessions s
    LEFT JOIN session_task_classes stc ON stc.session_id = s.id
    WHERE s.id = $1`,
    [id],
  );
  if (!row) throw new Error("missing session");
  return { value: taskClass(row.value), source: source(row.source) };
}

/**
 * Stores or clears the correction of one session and returns the class the API now reports. The
 * correction is user data: ingest never rewrites `session_task_classes`. Null when no stored session
 * has this id, so the caller can answer 404 without a second read.
 */
export function writeSessionTaskClass(
  db: Database,
  id: string,
  input: TaskClassInput,
): Promise<SessionTaskClass | null> {
  return withDatabase(db, async () => {
    const [existing] = await db.all("SELECT id FROM sessions WHERE id = $1", [id]);
    if (!existing) return null;
    if (input.taskClass === null) {
      await db.run("DELETE FROM session_task_classes WHERE session_id = $1", [id]);
    } else {
      await db.run(
        `INSERT INTO session_task_classes (session_id, task_class) VALUES ($1, $2)
        ON CONFLICT (session_id) DO UPDATE SET task_class = excluded.task_class,
          updated_at = now()`,
        [id, input.taskClass],
      );
    }
    return readSessionTaskClass(db, id);
  });
}
