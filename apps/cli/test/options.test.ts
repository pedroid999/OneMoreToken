import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDatabasePath, parseServeOptions } from "../src/options";

const HOME = "/home/someone";

describe("defaultDatabasePath", () => {
  it("prefers OMT_DB", () => {
    expect(defaultDatabasePath({ OMT_DB: "/tmp/custom.duckdb" }, HOME)).toBe("/tmp/custom.duckdb");
  });

  it("uses XDG_DATA_HOME when set", () => {
    expect(defaultDatabasePath({ XDG_DATA_HOME: "/data" }, HOME)).toBe(
      join("/data", "one-more-token", "omt.duckdb"),
    );
  });

  it("falls back to ~/.local/share", () => {
    expect(defaultDatabasePath({}, HOME)).toBe(
      join(HOME, ".local", "share", "one-more-token", "omt.duckdb"),
    );
  });

  it("ignores empty variables", () => {
    expect(defaultDatabasePath({ OMT_DB: "", XDG_DATA_HOME: "" }, HOME)).toBe(
      join(HOME, ".local", "share", "one-more-token", "omt.duckdb"),
    );
  });
});

describe("parseServeOptions", () => {
  it("defaults to 127.0.0.1:4317 and the default database path", () => {
    expect(parseServeOptions([], {}, HOME)).toEqual({
      ok: true,
      options: {
        port: 4317,
        host: "127.0.0.1",
        db: join(HOME, ".local", "share", "one-more-token", "omt.duckdb"),
        help: false,
      },
    });
  });

  it("uses OMT_DB as the default database", () => {
    const result = parseServeOptions([], { OMT_DB: "/tmp/env.duckdb" }, HOME);
    expect(result).toMatchObject({ ok: true, options: { db: "/tmp/env.duckdb" } });
  });

  it("lets --db override OMT_DB", () => {
    const result = parseServeOptions(
      ["--db", "/tmp/flag.duckdb"],
      { OMT_DB: "/tmp/env.duckdb" },
      HOME,
    );
    expect(result).toMatchObject({ ok: true, options: { db: "/tmp/flag.duckdb" } });
  });

  it("accepts --port, --host and --flag=value forms", () => {
    expect(parseServeOptions(["--port=0", "--host", "0.0.0.0"], {}, HOME)).toMatchObject({
      ok: true,
      options: { port: 0, host: "0.0.0.0" },
    });
    expect(parseServeOptions(["--port", "65535"], {}, HOME)).toMatchObject({
      ok: true,
      options: { port: 65535 },
    });
  });

  it.each(["abc", "-1", "65536", "1.5", "", "0x10"])("rejects --port %j", (port) => {
    expect(parseServeOptions([`--port=${port}`], {}, HOME)).toEqual({
      ok: false,
      error: `invalid --port "${port}": expected an integer between 0 and 65535`,
    });
  });

  it("rejects options without a value", () => {
    const result = parseServeOptions(["--db"], {}, HOME);
    expect(result.ok).toBe(false);
  });

  it("accepts --help", () => {
    expect(parseServeOptions(["--help"], {}, HOME)).toMatchObject({
      ok: true,
      options: { help: true },
    });
  });
});
