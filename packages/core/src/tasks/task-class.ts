/**
 * Task classes of a session (spec §7.3, phase 5 L3). The class is derived in SQL from stored
 * evidence and can be corrected per session; the correction lives in `session_task_classes`.
 */
export const TASK_CLASSES = ["feature", "inline", "unknown"] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/** The overridable classes: `unknown` means "the data cannot tell", so it is never a correction. */
export const CORRECTABLE_TASK_CLASSES = ["feature", "inline"] as const;
export type CorrectableTaskClass = (typeof CORRECTABLE_TASK_CLASSES)[number];

export const TASK_CLASS_SOURCES = ["derived", "corrected"] as const;
export type TaskClassSource = (typeof TASK_CLASS_SOURCES)[number];

/**
 * Derived class of the session whose id is `sessionIdSql`, a SQL expression the caller controls
 * (for example `s.id`). `feature` needs positive evidence of documented work: a turn attributed to
 * a commit, or a subagent run whose parent is the session. `inline` needs only a resolved
 * repository, and everything else is `unknown`: the data cannot distinguish "made no commits" from
 * "we never looked".
 */
export function derivedTaskClassSql(sessionIdSql: string): string {
  return `CASE
  WHEN EXISTS (SELECT 1 FROM turns dt WHERE dt.session_id = ${sessionIdSql}
      AND EXISTS (SELECT 1 FROM turn_commits dtc WHERE dtc.turn_id = dt.id))
    OR EXISTS (SELECT 1 FROM subagent_runs dsr WHERE dsr.parent_session_id = ${sessionIdSql})
    THEN 'feature'
  WHEN EXISTS (SELECT 1 FROM session_repos dsr2 WHERE dsr2.session_id = ${sessionIdSql})
    THEN 'inline'
  ELSE 'unknown'
END`;
}
