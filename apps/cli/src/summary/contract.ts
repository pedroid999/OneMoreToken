/** Safe aggregate-only GET /api/summary contract (spec §4, §7.1). See README for semantics. */
export interface SummaryPeriod {
  from: string;
  to: string;
}
export interface CostCoverage {
  /** Sum of known costs only; null when none are known, never an inferred zero. */
  usd: number | null;
  known: number;
  unknown: number;
}
export interface Summary {
  period: SummaryPeriod;
  sessions: number;
  /** All normalized turns, including user turns; not just usage-bearing assistant turns. */
  turns: number;
  usageTurns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  costs: { reported: CostCoverage; computed: CostCoverage };
  pricing: {
    /** Catalog policy, not a claim about reported charges or historical billing accuracy. */
    basis: "current-reference" | "historical";
    /** UTC reference date (YYYY-MM-DD); null for historical pricing. */
    observedAt: string | null;
    /** Usage rows with absent/mismatched catalog hashes, including stored null costs.
     * Excluded from computed coverage until reingested; matching-hash unknowns are not stale.
     */
    staleUsageTurns: number;
  };
  days: { date: string; tokens: number }[];
  /** All currently stored issues, not filtered by the turn period. */
  issues: { warning: number; error: number; critical: number };
  quota: { status: "unavailable" };
}
