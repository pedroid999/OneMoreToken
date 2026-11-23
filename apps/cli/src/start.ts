import { exec } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Database,
  defaultProfilesPath,
  loadPricing,
  loadSubscriptions,
  migrate,
  openDatabase,
} from "@omt/core";
import { createApp } from "./app";
import { defaultIngestRoots, ingestSessions } from "./ingest/service";
import type { ServeOptions } from "./options";
import { type RunningServer, startServer, waitForSignal } from "./server";
import { defaultWebDist } from "./web/static";

const EXIT_OK = 0;
const EXIT_USAGE = 1;

/** Opens the browser at the dashboard URL. Injectable so tests never launch a real browser. */
export type OpenBrowser = (url: string) => Promise<void>;

/** Best-effort platform opener: resolves even when no opener exists (S6). */
export function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? `open ${JSON.stringify(url)}`
        : process.platform === "win32"
          ? `start "" ${JSON.stringify(url)}`
          : `xdg-open ${JSON.stringify(url)}`;
    exec(command, { timeout: 5_000 }, () => resolve());
  });
}

const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  "gentle-shell": "gentle-shell",
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
};

/** One line per agent whose session root exists on this machine (S7). Missing roots are skipped. */
export function detectAgentRoots(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const root of defaultIngestRoots(home, env)) {
    if (seen.has(root.agent)) continue;
    if (!existsSync(root.path)) continue;
    seen.add(root.agent);
    lines.push(`  - ${AGENT_LABELS[root.agent] ?? root.agent} (${root.agent})`);
  }
  return lines;
}

/** Validates the shipped pricing and subscriptions data before serving (S2). Honors OMT_DATA_DIR. */
export function validateBundledData(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    loadPricing(env.OMT_DATA_DIR ? join(env.OMT_DATA_DIR, "pricing.json") : undefined);
    loadSubscriptions(env.OMT_DATA_DIR ? join(env.OMT_DATA_DIR, "subscriptions.json") : undefined);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export interface StartDeps {
  waitForShutdown(server: RunningServer): Promise<void>;
  openBrowser?: OpenBrowser;
}

/** `omt start`: guided ingest + serve + open browser (spec S1, S2, S6, S7). */
export async function startCommand(
  args: string[],
  io: { stdout(text: string): void; stderr(text: string): void; env: NodeJS.ProcessEnv },
  deps: StartDeps,
): Promise<number> {
  const { parseServeOptions } = (await import("./options")) as typeof import("./options");
  const parsed = parseServeOptions(args, io.env, homedir());
  if (!parsed.ok) {
    io.stderr(`omt start: ${parsed.error}\n`);
    return EXIT_USAGE;
  }
  const options: ServeOptions = parsed.options;
  const open = deps.openBrowser ?? defaultOpenBrowser;

  io.stdout("omt start: One More Token\n");
  const detected = detectAgentRoots(homedir(), io.env);
  if (detected.length === 0) {
    io.stdout("  no agent session directories found yet; the dashboard still works\n");
  } else {
    io.stdout(`  agents detected:\n${detected.join("\n")}\n`);
  }
  const dataError = validateBundledData(io.env);
  if (dataError) {
    io.stderr(`omt start: bundled data is invalid: ${dataError}\n`);
    return EXIT_USAGE;
  }

  let db: Database | undefined;
  let server: RunningServer | undefined;
  try {
    // A fresh machine has no data home yet: create it before opening DuckDB.
    if (options.db !== ":memory:") mkdirSync(dirname(options.db), { recursive: true });
    db = await openDatabase(options.db);
    await migrate(db);
    // Discovery honors the injected env (hermetic tests); profiles load only for the real runtime.
    const home = io.env.HOME ?? homedir();
    const ingestOptions = {
      roots: defaultIngestRoots(home, io.env),
      ...(io.env === process.env ? { profilesPath: defaultProfilesPath(home) } : {}),
    };
    const metrics = await ingestSessions(db, {}, ingestOptions);
    io.stdout(
      `omt start: ingest files=${metrics.files} persisted=${metrics.persisted} skipped=${metrics.skipped} failed=${metrics.failed}\n`,
    );
    server = await startServer(
      createApp(db, {
        allowedHosts: [options.host],
        web: { dist: await defaultWebDist(io.env) },
      }),
      options.host,
      options.port,
    );
    const url = `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${server.port}`;
    io.stdout(`omt start: dashboard ready at ${url} (database: ${options.db})\n`);
    if (!options.noOpen) await open(url);
    await deps.waitForShutdown(server);
    io.stdout("omt start: stopped\n");
    return EXIT_OK;
  } catch (error) {
    io.stderr(`omt start: ${(error as Error).message}\n`);
    return 1;
  } finally {
    server?.close();
    db?.close();
  }
}
