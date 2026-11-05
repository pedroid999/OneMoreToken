import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Database,
  hashContent,
  loadPricing,
  migrate,
  openDatabase,
  PricingFileSchema,
} from "@omt/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseServeOptions } from "../src/options";
import { startReportScheduler } from "../src/reports/scheduler";
import { generateReports, type ReportsOptions } from "../src/reports/service";

let db: Database;
let home: string;
let reports: string;
let configPath: string;

const NOW = Date.parse("2026-11-05T08:00:00.000Z");
const CURRENT_PRICING = hashContent(JSON.stringify(PricingFileSchema.parse(loadPricing())));

const config = {
  version: 1,
  subscriptions: [{ id: "claude", planId: "claude-pro", match: [{ provider: "claude-bridge" }] }],
};

beforeEach(async () => {
  db = await openDatabase(":memory:");
  await migrate(db);
  home = mkdtempSync(join(tmpdir(), "omt-reports-"));
  reports = join(home, "reports");
  configPath = join(home, "subscriptions.json");
  writeFileSync(configPath, JSON.stringify(config));
  await db.run(
    `INSERT INTO sources (id, agent, path, adapter_version) VALUES ('src', 'gentle-shell', '/tmp/x', '3')`,
  );
  await db.run(
    `INSERT INTO sessions (id, source_id, agent, started_at, ended_at, format_version) VALUES
      ('s1', 'src', 'gentle-shell', '2026-10-27T09:00:00Z', '2026-10-28T11:00:00Z', '3')`,
  );
  await db.run(
    `INSERT INTO ingest_checkpoints VALUES ('src', 'content', '1', '2026-10-28T12:00:00Z', $1)`,
    [CURRENT_PRICING],
  );
  await db.run(
    `INSERT INTO turns (id, session_id, idx, role, ts, model, provider) VALUES
      ('t1', 's1', 0, 'assistant', '2026-10-27T10:00:00Z', 'claude-opus-5', 'claude-bridge'),
      ('t2', 's1', 1, 'assistant', '2026-10-28T10:00:00Z', 'claude-opus-5', 'claude-bridge')`,
  );
  await db.run(
    `INSERT INTO usage (turn_id, input_tokens, output_tokens, cache_read_tokens, computed_cost_usd) VALUES
      ('t1', 1000, 500, 2000, 1.5),
      ('t2', 100, 50, 0, 0.25)`,
  );
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

const options = (overrides: Partial<ReportsOptions> = {}): ReportsOptions => ({
  directory: reports,
  configPath,
  calibrationsPath: join(home, "calibrations.json"),
  language: "es",
  now: () => NOW,
  ...overrides,
});

describe("generateReports", () => {
  it("writes the weekly and monthly reports of the periods that ended most recently", async () => {
    const generated = await generateReports(db, options());

    expect(generated.map((report) => `${report.kind}:${report.id}`)).toEqual([
      "weekly:2026-W44",
      "monthly:2026-10",
    ]);
    expect(readdirSync(reports).sort()).toEqual(["monthly-2026-10.md", "weekly-2026-W44.md"]);
    const weekly = statSync(join(reports, "weekly-2026-W44.md"));
    expect(weekly.mode & 0o777).toBe(0o600);
    expect(statSync(reports).mode & 0o777).toBe(0o700);
  });

  it("renders the aggregates of the period in the chosen language", async () => {
    await generateReports(db, options());
    const spanish = statSync(join(reports, "weekly-2026-W44.md"));
    expect(spanish.size).toBeGreaterThan(0);
    const text = await import("node:fs").then((fs) =>
      fs.readFileSync(join(reports, "weekly-2026-W44.md"), "utf8"),
    );
    expect(text.startsWith("# Informe semanal · 2026-W44\n")).toBe(true);
    expect(text).toContain("2026-10-26 → 2026-11-01");
    expect(text).toContain("| gentle-shell | 1 |");
    const monthly = await import("node:fs").then((fs) =>
      fs.readFileSync(join(reports, "monthly-2026-10.md"), "utf8"),
    );
    expect(monthly.startsWith("# Wrapped mensual · 2026-10\n")).toBe(true);
    expect(monthly).toContain("## Destacados");
    expect(monthly).toContain("claude-opus-5");

    await generateReports(db, options({ language: "en", directory: join(home, "en") }));
    const english = await import("node:fs").then((fs) =>
      fs.readFileSync(join(home, "en", "weekly-2026-W44.md"), "utf8"),
    );
    expect(english.startsWith("# Weekly report · 2026-W44\n")).toBe(true);
  });

  it("never rewrites a report whose content did not change", async () => {
    await generateReports(db, options());
    const path = join(reports, "weekly-2026-W44.md");
    const before = statSync(path);
    const text = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));

    const second = await generateReports(db, options());
    expect(second.map((report) => report.written)).toEqual([false, false]);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"))).toBe(text);
  });

  it("regenerates the report when later data changes the closed period", async () => {
    await generateReports(db, options());
    const path = join(reports, "weekly-2026-W44.md");
    const before = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));

    await db.run(
      `INSERT INTO turns (id, session_id, idx, role, ts, model, provider) VALUES
        ('t3', 's1', 2, 'assistant', '2026-10-29T10:00:00Z', 'claude-opus-5', 'claude-bridge')`,
    );
    await db.run(
      `INSERT INTO usage (turn_id, input_tokens, output_tokens, computed_cost_usd) VALUES
        ('t3', 400, 100, 0.5)`,
    );

    const third = await generateReports(db, options());
    expect(third[0]?.written).toBe(true);
    const after = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
    expect(after).not.toBe(before);
  });

  it("refuses a symlinked reports directory and writes nothing outside it", async () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, reports);

    await expect(generateReports(db, options())).rejects.toThrow();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("startReportScheduler", () => {
  it("runs one pass at startup without waiting for the interval", async () => {
    const scheduler = startReportScheduler(db, { ...options(), intervalMs: 0 });
    try {
      await scheduler.runOnce();
      expect(readdirSync(reports).sort()).toEqual(["monthly-2026-10.md", "weekly-2026-W44.md"]);
    } finally {
      await scheduler.stop();
    }
  });

  it("reports a failed pass instead of throwing, and stops cleanly", async () => {
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, reports);
    const errors: unknown[] = [];
    const scheduler = startReportScheduler(db, {
      ...options(),
      intervalMs: 0,
      onError: (error) => errors.push(error),
    });
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await scheduler.stop();
    await scheduler.stop();
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});

describe("serve report options", () => {
  const env = { XDG_DATA_HOME: "/data" };
  const parse = (args: string[], environment: NodeJS.ProcessEnv = env) =>
    parseServeOptions(args, environment, "/home/me");

  it("defaults to Spanish reports in the data home, one pass per hour", () => {
    const parsed = parse([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options.reportsDirectory).toBe("/data/one-more-token/reports");
    expect(parsed.options.reportLanguage).toBe("es");
    expect(parsed.options.reportIntervalMs).toBe(3_600_000);
  });

  it("takes the language from the flag, then from the environment", () => {
    const flagged = parse(["--report-lang", "en"]);
    expect(flagged.ok && flagged.options.reportLanguage).toBe("en");
    const fromEnv = parse([], { ...env, OMT_REPORT_LANGUAGE: "en" });
    expect(fromEnv.ok && fromEnv.options.reportLanguage).toBe("en");
    const overridden = parse(["--report-lang", "es"], { ...env, OMT_REPORT_LANGUAGE: "en" });
    expect(overridden.ok && overridden.options.reportLanguage).toBe("es");
  });

  it("names the environment variable when that value is invalid", () => {
    expect(parse([], { ...env, OMT_REPORT_LANGUAGE: "fr" })).toEqual({
      ok: false,
      error: 'invalid OMT_REPORT_LANGUAGE "fr": expected "es" or "en"',
    });
  });

  it("rejects an unknown language and a bad interval", () => {
    const language = parse(["--report-lang", "fr"]);
    expect(language).toEqual({
      ok: false,
      error: 'invalid --report-lang "fr": expected "es" or "en"',
    });
    const interval = parse(["--report-interval-ms=abc"]);
    expect(interval).toEqual({
      ok: false,
      error: 'invalid --report-interval-ms "abc": expected an integer between 0 and 86400000',
    });
  });
});

describe("report invariants", () => {
  it("reports a failed interval pass instead of swallowing it (L27(7))", async () => {
    const errors: unknown[] = [];
    const scheduler = startReportScheduler(db, {
      ...options(),
      intervalMs: 25,
      onError: (error) => errors.push(error),
    });
    try {
      await scheduler.runOnce();
      rmSync(reports, { recursive: true, force: true });
      mkdirSync(join(home, "elsewhere"));
      symlinkSync(join(home, "elsewhere"), reports);
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    } finally {
      await scheduler.stop();
    }
  });

  it("renders a closed period from the data alone, whatever the clock (L27(4))", async () => {
    const openConfig = join(home, "subscriptions-usd.json");
    writeFileSync(
      openConfig,
      JSON.stringify({
        version: 1,
        subscriptions: [{ id: "oc", planId: "opencode-go", match: [{ provider: "opencode-go" }] }],
      }),
    );
    await db.run(
      `INSERT INTO turns (id, session_id, idx, role, ts, model, provider, subscription_id)
        VALUES ('tusd', 's1', 9, 'assistant', '2026-10-30T08:30:00Z', 'm', 'opencode-go', 'oc')`,
    );
    await db.run(
      `INSERT INTO usage (turn_id, input_tokens, output_tokens, computed_cost_usd, reported_cost_usd)
        VALUES ('tusd', 1000000, 100000, 25.0, 25.0)`,
    );
    await generateReports(
      db,
      options({ configPath: openConfig, now: () => Date.parse("2026-11-05T08:00:00.000Z") }),
    );
    const bytes = readFileSync(join(reports, "weekly-2026-W44.md"), "utf8");
    const second = await generateReports(
      db,
      options({ configPath: openConfig, now: () => Date.parse("2026-11-05T09:00:00.000Z") }),
    );
    expect(second.map((report) => report.written)).toEqual([false, false]);
    expect(readFileSync(join(reports, "weekly-2026-W44.md"), "utf8")).toBe(bytes);
  });

  it("refuses a symlinked report file and leaves no temp file (L27(3))", async () => {
    mkdirSync(reports, { mode: 0o700 });
    const outside = join(home, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(reports, "weekly-2026-W44.md"));
    await expect(generateReports(db, options())).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
    expect(readdirSync(reports).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps a single pass in flight at a time (L27(7))", async () => {
    const scheduler = startReportScheduler(db, { ...options(), intervalMs: 0 });
    try {
      expect(scheduler.runOnce()).toBe(scheduler.runOnce());
    } finally {
      await scheduler.stop();
    }
  });
});
