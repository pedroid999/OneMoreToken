import { isAbsolute, normalize } from "node:path";
import { parseArgs } from "node:util";
import { TurnSchema } from "@omt/core";
import type { ParseResult } from "./options";

export type IngestAgent = "claude-code" | "gentle-shell" | "pi";
export interface IngestOptions {
  agent?: IngestAgent;
  path?: string;
  /** File mtime discovery filter, not a turn timestamp filter or deletion instruction. */
  since?: string;
}
export const DEFAULT_API_URL = "http://127.0.0.1:7317";
export const INVALID_INGEST_OPTIONS = "invalid ingest options";

/** Strict shared API/client validation; never includes rejected values in diagnostics. */
export function validateIngestOptions(input: unknown): IngestOptions | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["agent", "path", "since"].includes(key))) return null;
  const options: IngestOptions = {};
  if ("agent" in value) {
    if (
      typeof value.agent !== "string" ||
      !["claude-code", "gentle-shell", "pi"].includes(value.agent)
    )
      return null;
    options.agent = value.agent as IngestAgent;
  }
  if ("path" in value) {
    if (
      !options.agent ||
      typeof value.path !== "string" ||
      !isAbsolute(value.path) ||
      value.path.includes("\0")
    )
      return null;
    options.path = normalize(value.path);
  }
  if ("since" in value) {
    const parsed = TurnSchema.shape.ts.safeParse(value.since);
    if (!parsed.success) return null;
    options.since = parsed.data;
  }
  return options;
}

/** No credentials, redirects, remote hosts, query strings or non-HTTP schemes for local paths. */
export function localApiUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseIngestOptions(args: string[]): ParseResult<{
  ingest: IngestOptions;
  url: string;
  help: boolean;
}> {
  try {
    const { values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        agent: { type: "string" },
        path: { type: "string" },
        since: { type: "string" },
        url: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const { url: inputUrl, help, ...input } = values;
    const url = localApiUrl(inputUrl ?? DEFAULT_API_URL);
    const ingest = validateIngestOptions(input);
    if (url && ingest) return { ok: true, options: { ingest, url, help: help ?? false } };
  } catch {
    // parseArgs may quote private input: expose only a fixed diagnostic.
  }
  return { ok: false, error: INVALID_INGEST_OPTIONS };
}
