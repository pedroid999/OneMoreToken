import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, run } from "../src/cli";

interface Captured {
  io: CliIo;
  out: () => string;
  err: () => string;
}

function capture(env: NodeJS.ProcessEnv = {}): Captured {
  let out = "";
  let err = "";
  return {
    io: {
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      env,
    },
    out: () => out,
    err: () => err,
  };
}

/** First-run guidance: with empty XDG homes nothing is found, but no path leaks into the output. */
function emptyHome(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, "home");
  mkdirSync(join(home, ".config"), { recursive: true });
  mkdirSync(join(home, ".local", "share"), { recursive: true });
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("omt start", () => {
  it("migrates, ingests, serves the dashboard and shuts down cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-start-"));
    dirs.push(dir);
    const dbPath = join(dir, "omt.duckdb");
    const c = capture(emptyHome(dir));
    const opened: string[] = [];
    let health: unknown;

    const code = await run(["start", "--port", "0", "--db", dbPath, "--no-open"], c.io, {
      async waitForShutdown(server) {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
        health = await res.json();
      },
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(code).toBe(0);
    expect(health).toEqual({ status: "ok", schemaVersion: 10 });
    expect(existsSync(dbPath)).toBe(true);
    expect(opened).toEqual([]);
    // First run: guidance names the detected agents, then ingest metrics, then the URL.
    expect(c.out()).toContain("omt start");
    expect(c.out()).toContain("http://127.0.0.1:");
    expect(c.out()).toMatch(/omt start: ingest files=\d+ persisted=\d+ skipped=\d+ failed=\d+\n/);
    expect(c.err()).toBe("");
  });

  it("opens the browser once at the served URL unless --no-open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-start-open-"));
    dirs.push(dir);
    const c = capture(emptyHome(dir));
    const opened: string[] = [];

    const code = await run(["start", "--port", "0", "--db", join(dir, "omt.duckdb")], c.io, {
      async waitForShutdown() {},
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(code).toBe(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?$/);
  });

  it("starts the dashboard when invoked with no subcommand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-bare-"));
    dirs.push(dir);
    const home = join(dir, "home");
    mkdirSync(join(home, ".config"), { recursive: true });
    mkdirSync(join(home, ".local", "share"), { recursive: true });
    const c = capture({
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
    });
    const opened: string[] = [];

    const code = await run([], c.io, {
      async waitForShutdown() {},
      openBrowser: async (url) => {
        opened.push(url);
      },
    });

    expect(code).toBe(0);
    expect(c.out()).toContain("omt start: One More Token");
    expect(c.out()).not.toContain("Usage: omt <command> [options]");
    expect(opened).toHaveLength(1);
  });

  it("rejects unknown options like serve does", async () => {
    const c = capture();
    const code = await run(["start", "--nope"], c.io);
    expect(code).toBe(1);
    expect(c.err()).toContain("omt start");
    expect(c.out()).toBe("");
  });
});
