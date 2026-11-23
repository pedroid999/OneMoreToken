/**
 * Agents whose adapter records the status of every tool call (spec §7.3, phase 5 S5).
 * `codex` is deliberately absent: its adapter stores every call as `ok` because the rollout has no
 * error status, so an error rate of 0 % would be a claim the data does not support. Views show such
 * a cell as unknown, never as zero.
 */
export const TOOL_ERROR_STATUS_AGENTS = ["claude-code", "gentle-shell", "opencode", "pi"] as const;

/** False for `codex` and for any agent without a known capability: unknown, not zero. */
export function toolErrorStatusKnown(agent: string): boolean {
  return (TOOL_ERROR_STATUS_AGENTS as readonly string[]).includes(agent);
}
