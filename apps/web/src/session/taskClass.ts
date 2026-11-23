// Task class of a session (spec §7.3): derived from its commits and subagents, correctable per
// session and kept as user data (Phase 5 L3, S2). The API always says whether it is derived or
// corrected. No React, no fetch in the parsing helpers: the write is one PUT.

export type TaskClassValue = "feature" | "inline" | "unknown";
export type TaskClassSource = "derived" | "corrected";

export interface TaskClassState {
  value: TaskClassValue;
  source: TaskClassSource;
}

/** Picker choice: a class to correct with, or "auto" to clear the correction. */
export type TaskClassChoice = "feature" | "inline" | "auto";

const VALUES = new Set<string>(["feature", "inline", "unknown"]);
const SOURCES = new Set<string>(["derived", "corrected"]);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isTaskClassState = (value: unknown): value is TaskClassState =>
  record(value) &&
  typeof value.value === "string" &&
  VALUES.has(value.value) &&
  typeof value.source === "string" &&
  SOURCES.has(value.source);

/** `taskClass` of GET /api/sessions/:id, additive: null when the payload does not carry it. */
export function readTaskClass(payload: unknown): TaskClassState | null {
  if (!record(payload)) return null;
  return isTaskClassState(payload.taskClass) ? payload.taskClass : null;
}

export function taskClassPath(sessionId: string): string {
  return `/api/sessions/${sessionId}/task-class`;
}

/** Checked option of the picker: the correction when there is one, else the derived class. */
export function taskClassChoice(state: TaskClassState): TaskClassChoice {
  if (state.source === "corrected" && state.value !== "unknown") return state.value;
  return "auto";
}

/** PUT body: null clears the correction, so the derived class wins again (L3). */
export function taskClassBody(choice: TaskClassChoice): {
  taskClass: "feature" | "inline" | null;
} {
  return { taskClass: choice === "auto" ? null : choice };
}

/** Response of the PUT: the class the server now reports, or null when the write failed. */
export function readTaskClassResponse(payload: unknown): TaskClassState | null {
  if (!record(payload)) return null;
  const state = { value: payload.taskClass, source: payload.source };
  return isTaskClassState(state) ? state : null;
}

/** Applies a choice through PUT /api/sessions/:id/task-class; null when it was rejected. */
export async function saveTaskClass(
  sessionId: string,
  choice: TaskClassChoice,
): Promise<TaskClassState | null> {
  const response = await fetch(taskClassPath(sessionId), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(taskClassBody(choice)),
  });
  if (!response.ok) return null;
  return readTaskClassResponse(await response.json());
}
