import { describe, expect, it } from "vitest";
import type { ProfileEffort, ProfileFigures, ProfileReport } from "../src/profiles/contract";
import {
  attributionOf,
  comparisonRows,
  comparisonSpec,
  effortGroups,
  perSession,
  profileColor,
  profilesRequest,
  ROLE_CATEGORIES,
  roleCategory,
  shortHash,
  sortedRoles,
} from "../src/profiles/state";

const figures = (patch: Partial<ProfileFigures> = {}): ProfileFigures => ({
  turns: 4,
  sessions: 2,
  input: 100,
  output: 50,
  cacheRead: 30,
  cacheWrite: 20,
  total: 200,
  computedCost: 3,
  reportedCost: null,
  exactTurns: 4,
  estimatedTurns: 0,
  exactShare: 1,
  estimatedShare: 0,
  ...patch,
});

const effort = (model: string | null, level: string | null): ProfileEffort => ({
  provider: "anthropic",
  model,
  effort: level,
  ...figures(),
});

describe("profiles request (S9)", () => {
  it("asks only for the period, encoded like the other views", () => {
    expect(
      profilesRequest({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" }),
    ).toBe("/api/profiles?from=2026-01-01T00%3A00%3A00.000Z&to=2026-01-08T00%3A00%3A00.000Z");
  });
});

describe("per-session figures (S7: total and per session)", () => {
  it("divides cost and tokens by the root sessions", () => {
    expect(perSession(figures({ computedCost: 3, total: 200, sessions: 2 }))).toEqual({
      cost: 1.5,
      tokens: 100,
    });
  });

  it("is unknown without sessions or without a computed cost", () => {
    expect(perSession(figures({ sessions: 0 }))).toEqual({ cost: null, tokens: null });
    expect(perSession(figures({ computedCost: null }))).toEqual({ cost: null, tokens: 100 });
  });
});

describe("attribution (spec §6.2: exact vs estimated)", () => {
  it("tells exact, estimated, mixed and none apart", () => {
    expect(attributionOf(figures({ exactTurns: 3, estimatedTurns: 0 }))).toBe("exact");
    expect(attributionOf(figures({ exactTurns: 0, estimatedTurns: 3 }))).toBe("estimated");
    expect(attributionOf(figures({ exactTurns: 1, estimatedTurns: 3 }))).toBe("mixed");
    expect(attributionOf(figures({ exactTurns: 0, estimatedTurns: 0 }))).toBe("none");
  });
});

describe("roles (S7: orchestrator, explorer, writers, verifier, reviewers)", () => {
  it("maps stored gentle-shell roles to the spec categories", () => {
    expect(roleCategory("orchestrator")).toBe("orchestrator");
    expect(roleCategory("gentle-ai-explore")).toBe("explorer");
    expect(roleCategory("gentle-ai-worker")).toBe("writer");
    expect(roleCategory("gentle-ai-writer")).toBe("writer");
    expect(roleCategory("gentle-ai-verify")).toBe("verifier");
    expect(roleCategory("review-risk")).toBe("reviewer");
    expect(roleCategory("jd-judge-a")).toBe("reviewer");
    expect(roleCategory("unknown")).toBe("unknown");
    expect(roleCategory("something-else")).toBe("other");
    expect(roleCategory(null)).toBe("outside");
  });

  it("orders roles by category, then by stored name", () => {
    const roles = ["review-risk", "unknown", "gentle-ai-worker", "orchestrator", "review-a", null];
    expect(sortedRoles(roles.map((role) => ({ role, ...figures() }))).map((r) => r.role)).toEqual([
      "orchestrator",
      "gentle-ai-worker",
      "review-a",
      "review-risk",
      "unknown",
      null,
    ]);
    expect(ROLE_CATEGORIES[0]).toBe("orchestrator");
  });
});

describe("effort as an independent dimension (S7)", () => {
  it("groups efforts of the same model and flags models used with several efforts", () => {
    const groups = effortGroups([
      effort("opus", "high"),
      effort("opus", "low"),
      effort("sonnet", "medium"),
      effort(null, null),
    ]);
    expect(groups.map((g) => [g.model, g.rows.map((r) => r.effort), g.compared])).toEqual([
      ["opus", ["high", "low"], true],
      ["sonnet", ["medium"], false],
      [null, [null], false],
    ]);
  });
});

describe("versions (spec §6.2)", () => {
  it("shortens snapshot hashes to 12 characters", () => {
    expect(shortHash("abcdef0123456789abcdef")).toBe("abcdef012345");
  });
});

describe("comparison chart", () => {
  const profile = (name: string, totals: Partial<ProfileFigures>): ProfileReport => ({
    name,
    versions: [],
    totals: figures(totals),
    sessions: [],
    roles: [],
    efforts: [],
    subscriptions: [],
  });

  it("gives every profile a stable colour from the palette, whatever the order", () => {
    const palette = ["#1", "#2", "#3"];
    const a = profileColor("deep", palette);
    expect(palette).toContain(a);
    expect(profileColor("deep", palette)).toBe(a);
    expect(profileColor("deep", [...palette])).toBe(a);
  });

  it("builds one row per profile with cost and tokens, per session included", () => {
    expect(
      comparisonRows([profile("a", { computedCost: 4, total: 300, sessions: 2 })], ["#1"]),
    ).toEqual([
      {
        profile: "a",
        color: "#1",
        cost: 4,
        tokens: 300,
        costPerSession: 2,
        tokensPerSession: 150,
      },
    ]);
  });

  it("keeps the spec data-free, with translated titles and stable colours", () => {
    const spec = comparisonSpec({
      profile: "Profile",
      cost: "Cost",
      tokens: "Tokens",
      domain: ["a", "b"],
      colors: ["#1", "#2"],
    });
    expect(spec.data).toEqual({ name: "table" });
    const text = JSON.stringify(spec);
    expect(text).toContain('"Cost"');
    expect(text).toContain('"Tokens"');
    expect(text).toContain('"range":["#1","#2"]');
    expect(text).not.toContain('"values"');
  });
});
