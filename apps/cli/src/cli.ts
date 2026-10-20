import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type Database, migrate, openDatabase } from "@omt/core";
import { createApp } from "./app";
import { DEFAULT_HOST, DEFAULT_PORT, parseServeOptions, type ServeOptions } from "./options";
import { type RunningServer, startServer, waitForSignal } from "./server";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
}

export interface CliDeps {
  /** Resolves when `omt serve` should stop. Defaults to SIGINT/SIGTERM. */
  waitForShutdown(server: RunningServer): Promise<void>;
}

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_NOT_IMPLEMENTED = 2;

const HELP_HINT = "Run `omt --help` for usage.";

export const USAGE = `One More Token: local dashboard for AI coding agent usage.

Usage: omt <command> [options]

Commands:
  serve     Open the database, apply migrations and start the dashboard API
  ingest    Ingest local agent sessions (phase 1)
  watch     Ingest continuously while serving (phase 1)

Options for serve:
  --port <n>      Port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)
  --host <h>      Address to bind (default ${DEFAULT_HOST}, local only)
  --db <path>     DuckDB file (default $OMT_DB, else
                  \${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb)

Global options:
  -h, --help      Show this help
`;

/** Runs one CLI invocation and returns its exit code. Never calls process.exit. */
export async function run(
  argv: string[],
  io: CliIo,
  deps: CliDeps = { waitForShutdown: () => waitForSignal() },
): Promise<number> {
  const [command, ...args] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return EXIT_OK;
  }
  if (command.startsWith("-")) {
    return usageError(io, "omt", `unknown option "${command}"`);
  }

  switch (command) {
    case "serve":
      return serveCommand(args, io, deps);
    case "ingest":
    case "watch":
      io.stderr(
        `omt ${command}: not implemented yet; it arrives in phase 1 (see docs/spec.md §12).\n`,
      );
      return EXIT_NOT_IMPLEMENTED;
    default:
      return usageError(io, "omt", `unknown command "${command}"`);
  }
}

function usageError(io: CliIo, prefix: string, message: string): number {
  io.stderr(`${prefix}: ${message}\n${HELP_HINT}\n`);
  return EXIT_USAGE;
}

async function serveCommand(args: string[], io: CliIo, deps: CliDeps): Promise<number> {
  const parsed = parseServeOptions(args, io.env, homedir());
  if (!parsed.ok) return usageError(io, "omt serve", parsed.error);
  if (parsed.options.help) {
    io.stdout(USAGE);
    return EXIT_OK;
  }

  let db: Database | undefined;
  let server: RunningServer | undefined;
  try {
    db = await openMigratedDatabase(parsed.options);
    server = await startServer(
      createApp(db, { allowedHosts: [parsed.options.host] }),
      parsed.options.host,
      parsed.options.port,
    );
    io.stdout(
      `omt serve: listening on http://${urlHost(server.host)}:${server.port} (database: ${parsed.options.db})\n`,
    );
    await deps.waitForShutdown(server);
    return EXIT_OK;
  } catch (error) {
    io.stderr(`omt serve: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  } finally {
    await server?.close();
    db?.close();
    if (server) io.stdout("omt serve: stopped\n");
  }
}

/** This process is the single DuckDB writer (spec §11.1); ingestion will run inside it. */
async function openMigratedDatabase(options: ServeOptions): Promise<Database> {
  if (options.db !== ":memory:") mkdirSync(dirname(options.db), { recursive: true });
  const db = await openDatabase(options.db);
  try {
    await migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function urlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
