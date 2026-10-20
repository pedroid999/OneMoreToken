import { describe, expect, it } from "vitest";
import { matchRoute, ROUTES } from "../src/router";

describe("router (spec §8.1: the URL reflects the state)", () => {
  it("lists the nine views of §7.1 plus settings and about", () => {
    expect(ROUTES.map((r) => r.id)).toEqual([
      "summary",
      "burnRate",
      "explorer",
      "session",
      "profiles",
      "agents",
      "git",
      "tools",
      "sql",
      "settings",
      "about",
    ]);
  });

  it("matches known paths, with or without a trailing slash", () => {
    expect(matchRoute("/").id).toBe("summary");
    expect(matchRoute("/settings").id).toBe("settings");
    expect(matchRoute("/burn-rate/").id).toBe("burnRate");
  });

  it("sends unknown paths to Summary", () => {
    expect(matchRoute("/nope").id).toBe("summary");
    expect(matchRoute("/settings/extra").id).toBe("summary");
  });

  it("assigns the spec §12 phase to every view not built in phase 0", () => {
    const phases = Object.fromEntries(ROUTES.map((r) => [r.id, r.phase]));
    expect(phases).toEqual({
      summary: undefined,
      burnRate: 3,
      explorer: 2,
      session: 2,
      profiles: 3,
      agents: 2,
      git: 4,
      tools: 2,
      sql: 4,
      settings: undefined,
      about: undefined,
    });
  });
});
