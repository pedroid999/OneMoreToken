import { join } from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_PORT = 4317;
/** Local only by default (spec §10). */
export const DEFAULT_HOST = "127.0.0.1";

export interface ServeOptions {
  port: number;
  host: string;
  db: string;
  help: boolean;
}

export type ParseResult<T> = { ok: true; options: T } | { ok: false; error: string };

/** `$OMT_DB`, else `${XDG_DATA_HOME:-~/.local/share}/one-more-token/omt.duckdb`. */
export function defaultDatabasePath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.OMT_DB) return env.OMT_DB;
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "one-more-token", "omt.duckdb");
}

export function parseServeOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string,
): ParseResult<ServeOptions> {
  let values: { port?: string | undefined; host?: string | undefined; db?: string | undefined };
  let help = false;
  try {
    const parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        db: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    values = parsed.values;
    help = parsed.values.help ?? false;
  } catch (error) {
    return { ok: false, error: describeParseError(error) };
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) {
      return {
        ok: false,
        error: `invalid --port "${values.port}": expected an integer between 0 and 65535`,
      };
    }
    port = Number(values.port);
  }

  return {
    ok: true,
    options: {
      port,
      host: values.host ?? DEFAULT_HOST,
      db: values.db ?? defaultDatabasePath(env, home),
      help,
    },
  };
}

/** Turns `node:util` parseArgs errors into short, stable messages. */
export function describeParseError(error: unknown): string {
  const { code, message } = error as { code?: string; message: string };
  const subject = /'([^']+)'/.exec(message)?.[1] ?? "";
  switch (code) {
    case "ERR_PARSE_ARGS_UNKNOWN_OPTION":
      return `unknown option "${subject}"`;
    case "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL":
      return `unexpected argument "${subject}"`;
    case "ERR_PARSE_ARGS_INVALID_OPTION_VALUE":
      return `invalid value for "${subject.split(" ")[0]}": ${message}`;
    default:
      return message;
  }
}
