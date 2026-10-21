import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, parse, sep } from "node:path";
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  GENTLE_SHELL_ADAPTER_VERSION,
  PI_ADAPTER_VERSION,
  parseClaudeCode,
  parseGentleShell,
  parsePi,
} from "@omt/adapters";
import { type Database, ingestSource, loadPricing, type SourceParser } from "@omt/core";
import { withDatabase } from "../db-queue";
import { type IngestAgent, type IngestOptions, validateIngestOptions } from "../ingest-options";

/** POST /api/ingest response. All counters are nonnegative integers for this request only.
 * files: selected JSONL snapshots attempted; persisted/skipped: core checkpoint outcomes;
 * failed: file processing/directory discovery failures; issues: newly parsed row issues plus failures.
 * Missing default roots and symlinks are ignored. No paths/content/exception text are returned.
 * Previously stored issues in unchanged files are not counted again.
 */
export interface IngestMetrics {
  files: number;
  persisted: number;
  skipped: number;
  failed: number;
  issues: number;
}
export interface IngestRoot {
  agent: IngestAgent;
  path: string;
}
export interface IngestFileSystem {
  lstat(path: string): Promise<Stats>;
  readdir(path: string): Promise<Dirent[]>;
  readFile(path: string): Promise<string>;
}
export interface IngestServiceOptions {
  /** Replaces all home-directory discovery. Pass [] to disable default discovery in tests. */
  roots?: readonly IngestRoot[];
  now?: () => string;
  fs?: IngestFileSystem;
  parsers?: Partial<Record<IngestAgent, SourceParser>>;
}
const adapters = {
  "claude-code": { version: CLAUDE_CODE_ADAPTER_VERSION, parse: parseClaudeCode },
  "gentle-shell": { version: GENTLE_SHELL_ADAPTER_VERSION, parse: parseGentleShell },
  pi: { version: PI_ADAPTER_VERSION, parse: parsePi },
};
const sourceFs: IngestFileSystem = {
  lstat,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
};
export function defaultIngestRoots(home = homedir()): IngestRoot[] {
  return [
    { agent: "claude-code", path: join(home, ".claude", "projects") },
    { agent: "gentle-shell", path: join(home, ".gentle-shell", "agent", "sessions") },
    { agent: "pi", path: join(home, ".pi", "agent", "sessions") },
  ];
}

/** One whole-file read at a time; changed/appending files are replaced atomically on the next run.
 * The complete request, not each file, owns the database queue (spec §3, §10, §11.1).
 */
export function ingestSessions(
  db: Database,
  input: IngestOptions,
  options: IngestServiceOptions = {},
): Promise<IngestMetrics> {
  const request = validateIngestOptions(input);
  if (!request) return Promise.reject(new Error("invalid ingest options"));
  return withDatabase(db, async () => {
    const metrics: IngestMetrics = { files: 0, persisted: 0, skipped: 0, failed: 0, issues: 0 };
    const fs = options.fs ?? sourceFs;
    const ingestedAt = (options.now ?? (() => new Date().toISOString()))();
    const pricing = loadPricing();
    const since = request.since === undefined ? -Infinity : Date.parse(request.since);
    const roots =
      request.path && request.agent
        ? [{ agent: request.agent, path: request.path }]
        : (options.roots ?? defaultIngestRoots()).filter(
            (root) => !request.agent || root.agent === request.agent,
          );
    const visited = new Set<string>();
    const failure = () => {
      metrics.failed++;
      metrics.issues++;
    };
    const file = async (path: string, agent: IngestAgent, info: Stats) => {
      if (info.mtimeMs < since) return;
      metrics.files++;
      try {
        const content = await fs.readFile(path);
        const adapter = adapters[agent];
        let issues = 0;
        const result = await ingestSource(
          db,
          content,
          {
            agent,
            path,
            adapterVersion: adapter.version,
            ingestedAt,
            pricing,
          },
          (text, context) => {
            const batch = (options.parsers?.[agent] ?? adapter.parse)(text, context);
            issues = batch.issues.length;
            return batch;
          },
        );
        metrics[result]++;
        metrics.issues += issues;
      } catch {
        failure();
      }
    };
    const walk = async (path: string, agent: IngestAgent): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(path);
      } catch {
        failure();
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        try {
          const info = await fs.lstat(child);
          if (info.isSymbolicLink()) continue;
          if (info.isDirectory()) await walk(child, agent);
          else if (info.isFile() && child.endsWith(".jsonl")) await file(child, agent, info);
        } catch {
          failure();
        }
      }
    };
    for (const root of roots) {
      const path = normalize(root.path);
      if (visited.has(path)) continue;
      visited.add(path);
      try {
        // Inspect ancestors as well: ~/.pi/agent may itself link to gentle-shell's home.
        let cursor = parse(path).root;
        let linked = false;
        for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
          cursor = join(cursor, part);
          const info = await fs.lstat(cursor);
          if (info.isSymbolicLink()) {
            linked = true;
            break;
          }
          if (!info.isDirectory()) throw new Error("not a directory");
        }
        if (!linked) await walk(path, root.agent);
      } catch (error) {
        if (!request.path && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        failure();
      }
    }
    return metrics;
  });
}
