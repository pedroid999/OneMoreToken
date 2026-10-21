import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

const HELP_HINT = "Run `omt --help` for usage.\n";

describe("omt help", () => {
  it("prints usage to stdout and exits 0 with --help", async () => {
    const c = capture();
    expect(await run(["--help"], c.io)).toBe(0);
    expect(c.out()).toContain("Usage: omt <command> [options]");
    expect(c.out()).toContain("serve");
    expect(c.out()).toContain("ingest");
    expect(c.out()).toContain("watch");
    expect(c.out()).toContain("--port <n>");
    expect(c.err()).toBe("");
  });

  it("prints the same usage with -h and with no command", async () => {
    const help = capture();
    await run(["--help"], help.io);
    const short = capture();
    const none = capture();
    expect(await run(["-h"], short.io)).toBe(0);
    expect(await run([], none.io)).toBe(0);
    expect(short.out()).toBe(help.out());
    expect(none.out()).toBe(help.out());
    expect(none.err()).toBe("");
  });

  it("prints usage for serve --help without starting a server", async () => {
    const help = capture();
    await run(["--help"], help.io);
    const c = capture();
    expect(await run(["serve", "--help"], c.io)).toBe(0);
    expect(c.out()).toBe(help.out());
    expect(c.err()).toBe("");
  });
});

describe("omt ingest / watch", () => {
  it.each(["ingest", "watch"])("%s is not available in phase 0 and exits 2", async (command) => {
    const c = capture();
    expect(await run([command], c.io)).toBe(2);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(
      `omt ${command}: not implemented yet; it arrives in phase 1 (see docs/spec.md §12).\n`,
    );
  });
});

describe("omt errors", () => {
  it("rejects an unknown command with exit 1 and a help hint", async () => {
    const c = capture();
    expect(await run(["frobnicate"], c.io)).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(`omt: unknown command "frobnicate"\n${HELP_HINT}`);
  });

  it("rejects an unknown global option with exit 1", async () => {
    const c = capture();
    expect(await run(["--nope"], c.io)).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(`omt: unknown option "--nope"\n${HELP_HINT}`);
  });

  it("rejects an unknown serve option with exit 1", async () => {
    const c = capture();
    expect(await run(["serve", "--nope"], c.io)).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toMatch(/^omt serve: .*--nope.*\n/);
    expect(c.err().endsWith(HELP_HINT)).toBe(true);
  });

  it("rejects unexpected positional arguments for serve", async () => {
    const c = capture();
    expect(await run(["serve", "extra"], c.io)).toBe(1);
    expect(c.err()).toMatch(/^omt serve: .*extra.*\n/);
    expect(c.err().endsWith(HELP_HINT)).toBe(true);
  });

  it.each(["abc", "-1", "65536", "1.5", ""])("rejects --port %j with exit 1", async (port) => {
    const c = capture();
    expect(await run(["serve", `--port=${port}`], c.io)).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(
      `omt serve: invalid --port "${port}": expected an integer between 0 and 65535\n${HELP_HINT}`,
    );
  });
});

describe("omt serve", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("opens the database, migrates, serves /api/health and shuts down cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omt-cli-"));
    dirs.push(dir);
    const dbPath = join(dir, "nested", "omt.duckdb");
    const c = capture();
    let health: unknown;

    const code = await run(["serve", "--port", "0", "--db", dbPath], c.io, {
      async waitForShutdown(server) {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
        health = await res.json();
      },
    });

    expect(code).toBe(0);
    expect(health).toEqual({ status: "ok", schemaVersion: 2 });
    expect(existsSync(dbPath)).toBe(true);
    expect(c.err()).toBe("");
    expect(c.out()).toMatch(
      /^omt serve: listening on http:\/\/127\.0\.0\.1:\d+ \(database: .*omt\.duckdb\)\nomt serve: stopped\n$/,
    );
  });
});
