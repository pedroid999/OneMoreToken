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

describe("omt watch", () => {
  it.each(["watch"])("%s remains a stub and exits 2", async (command) => {
    const c = capture();
    expect(await run([command], c.io)).toBe(2);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(
      `omt ${command}: not implemented yet; it arrives in phase 1 (see docs/spec.md §12).\n`,
    );
  });
});

describe("omt ingest client", () => {
  it("prints help without making requests", async () => {
    const c = capture();
    expect(
      await run(["ingest", "--help"], c.io, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).toBe(0);
    expect(c.out()).toContain("--since <timestamp>");
    expect(c.out()).toContain("--url <url>");
    expect(c.err()).toBe("");
  });

  it("posts options to the loopback server and prints only fixed counters", async () => {
    const c = capture();
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const code = await run(
      [
        "ingest",
        "--url",
        "http://localhost:7318",
        "--agent",
        "pi",
        "--path",
        "/synthetic",
        "--since",
        "2026-01-01T00:00:00Z",
      ],
      c.io,
      {
        fetch: async (url, init) => {
          requests.push({ url: String(url), init });
          return Response.json({
            files: 3,
            persisted: 1,
            skipped: 1,
            failed: 1,
            issues: 2,
            private: "SECRET",
          });
        },
      },
    );
    expect(code).toBe(0);
    expect(c.out()).toBe("omt ingest: files=3 persisted=1 skipped=1 failed=1 issues=2\n");
    expect(c.err()).toBe("");
    expect(requests).toEqual([
      {
        url: "http://localhost:7318/api/ingest",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          redirect: "error",
          body: JSON.stringify({ agent: "pi", path: "/synthetic", since: "2026-01-01T00:00:00Z" }),
        },
      },
    ]);
  });

  it("uses the default URL and lets the server discover roots", async () => {
    const c = capture();
    expect(
      await run(["ingest"], c.io, {
        fetch: async (url, init) => {
          expect(String(url)).toBe("http://127.0.0.1:7317/api/ingest");
          expect(init?.body).toBe("{}");
          return Response.json({ files: 0, persisted: 0, skipped: 0, failed: 0, issues: 0 });
        },
      }),
    ).toBe(0);
    expect(c.out()).toBe("omt ingest: files=0 persisted=0 skipped=0 failed=0 issues=0\n");
    expect(c.err()).toBe("");
  });

  it.each([
    ["--path", "/synthetic"],
    ["--agent", "other"],
    ["--agent", "pi", "--path", "relative"],
    ["--since", "bad"],
    ["--since", "2026-02-30T00:00:00Z"],
    ["--nope"],
    ["extra"],
    ["--agent"],
    ...[
      "http://evil.example",
      "https://localhost",
      "http://localhost.evil",
      "http://user:pass@localhost",
      "http://localhost/?secret=x",
      "http://localhost/other",
      "http://127.0.0.1#secret",
    ].map((url) => ["--url", url]),
  ])("rejects invalid input %j without sending local paths", async (...args) => {
    const c = capture();
    let calls = 0;
    expect(
      await run(["ingest", ...args], c.io, {
        fetch: async () => {
          calls++;
          throw new Error("must not fetch");
        },
      }),
    ).toBe(1);
    expect(calls).toBe(0);
    expect(c.out()).toBe("");
    expect(c.err()).toBe(`omt ingest: invalid ingest options\n${HELP_HINT}`);
  });

  it.each(["network", "api", "json", "metrics"])("sanitizes %s failures", async (failure) => {
    const c = capture();
    expect(
      await run(["ingest"], c.io, {
        fetch: async () => {
          if (failure === "network") throw new Error("PRIVATE_SENTINEL /private/path");
          if (failure === "api")
            return Response.json({ error: "PRIVATE_SENTINEL" }, { status: 500 });
          if (failure === "json") return new Response("PRIVATE_SENTINEL");
          return Response.json({ files: -1, persisted: "PRIVATE_SENTINEL" });
        },
      }),
    ).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toBe("omt ingest: request failed; check that omt serve is running.\n");
  });

  it.each(["watch", "serve"])("does not add ingest options to %s", async (command) => {
    const c = capture();
    expect(await run([command, "--since", "2026-01-01T00:00:00Z"], c.io)).toBe(
      command === "watch" ? 2 : 1,
    );
    expect(c.out()).toBe("");
    expect(c.err()).toBe(
      command === "watch"
        ? "omt watch: not implemented yet; it arrives in phase 1 (see docs/spec.md §12).\n"
        : `omt serve: unknown option "--since"\n${HELP_HINT}`,
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
    expect(health).toEqual({ status: "ok", schemaVersion: 3 });
    expect(existsSync(dbPath)).toBe(true);
    expect(c.err()).toBe("");
    expect(c.out()).toMatch(
      /^omt serve: listening on http:\/\/127\.0\.0\.1:\d+ \(database: .*omt\.duckdb\)\nomt serve: stopped\n$/,
    );
  });
});
