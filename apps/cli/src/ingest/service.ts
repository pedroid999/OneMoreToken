import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, normalize, parse, sep } from "node:path";
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  CODEX_ADAPTER_VERSION,
  codexSessionMeta,
  createCodexDocument,
  createGentleSubagentDocument,
  GENTLE_SHELL_ADAPTER_VERSION,
  GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION,
  type GentleTaskRecord,
  OPENCODE_ADAPTER_VERSION,
  PI_ADAPTER_VERSION,
  parseClaudeCode,
  parseCodex,
  parseGentleShell,
  parseGentleShellSubagent,
  parseOpenCode,
  parsePi,
  readGentleTaskRecord,
  readOpenCodeSessions,
} from "@omt/adapters";
import {
  type Database,
  defaultProfilesPath,
  ingestSource,
  loadPricing,
  readProfilesFile,
  recomputeCommitAttribution,
  recomputeProfileAttribution,
  type SourceParser,
  upsertProfiles,
} from "@omt/core";
import { withDatabase } from "../db-queue";
import { syncGitRepos } from "../git/sync";
import { type IngestAgent, type IngestOptions, validateIngestOptions } from "../ingest-options";

/** POST /api/ingest response. All counters are nonnegative integers for this request only.
 * files: selected JSONL snapshots (OpenCode: sessions) attempted;
 * persisted/skipped: core checkpoint outcomes;
 * failed: file processing/directory discovery failures (OpenCode: unreadable database/session;
 * gentle-shell subagents: unreadable or invalid task records too);
 * issues: newly parsed row issues plus failures.
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
  /** `subagents`: a gentle-shell `gentle-agents` directory (`sessions/`, `tasks/`) whose parents
   * live in `parents` (D4). Explicit `--path` requests always walk plain transcripts. */
  kind?: "subagents";
  parents?: string;
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
  /** gentle-shell `profiles.json` (D5). Defaults to the real file only with default discovery
   * (no `roots`), so tests never read the home directory. */
  profilesPath?: string;
}
const adapters = {
  "claude-code": { version: CLAUDE_CODE_ADAPTER_VERSION, parse: parseClaudeCode },
  "gentle-shell": { version: GENTLE_SHELL_ADAPTER_VERSION, parse: parseGentleShell },
  pi: { version: PI_ADAPTER_VERSION, parse: parsePi },
  opencode: { version: OPENCODE_ADAPTER_VERSION, parse: parseOpenCode },
  codex: { version: CODEX_ADAPTER_VERSION, parse: parseCodex },
};
const sourceFs: IngestFileSystem = {
  lstat,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  readFile: (path) => readFile(path, "utf8"),
};
export function defaultIngestRoots(
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): IngestRoot[] {
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  const gentle = join(home, ".gentle-shell", "agent");
  return [
    { agent: "claude-code", path: join(home, ".claude", "projects") },
    { agent: "gentle-shell", path: join(gentle, "sessions") },
    {
      agent: "gentle-shell",
      kind: "subagents",
      path: join(gentle, "gentle-agents"),
      parents: join(gentle, "sessions"),
    },
    { agent: "pi", path: join(home, ".pi", "agent", "sessions") },
    { agent: "opencode", path: join(dataHome, "opencode") },
    { agent: "codex", path: join(home, ".codex", "sessions") },
  ];
}

/** The Codex sessions root of a walked path: `--path` may point at a `YYYY[/MM[/DD]]` directory
 * below it, while parent rollouts can live under any other day (L6a). */
export function codexSessionsRoot(path: string): string {
  // `normalize` keeps a trailing separator (shell completion adds one): drop empty tail segments.
  const parts = path.split(sep);
  while (parts.length > 1 && parts.at(-1) === "") parts.pop();
  const pattern = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
  for (let depth = 3; depth > 0; depth--) {
    const tail = parts.slice(-depth);
    if (parts.length > depth + 1 && tail.every((part, index) => pattern[index]?.test(part))) {
      return parts.slice(0, -depth).join(sep);
    }
  }
  return path;
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
    // Read-only profile snapshots (L10); a missing or invalid file only means none are added.
    const profilesPath =
      options.profilesPath ?? (options.roots === undefined ? defaultProfilesPath() : undefined);
    if (profilesPath)
      await upsertProfiles(db, readProfilesFile(profilesPath, ingestedAt).snapshots);
    const visited = new Set<string>();
    const failure = () => {
      metrics.failed++;
      metrics.issues++;
    };
    const ingest = async (
      path: string,
      agent: IngestAgent,
      read: () => Promise<string>,
      adapter: { version: string; parse: SourceParser } = adapters[agent],
      override = options.parsers?.[agent],
    ) => {
      metrics.files++;
      try {
        const content = await read();
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
            const batch = (override ?? adapter.parse)(text, context);
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
    // Codex rollouts are named `rollout-<ts>-<thread id>.jsonl` (D1); one index per sessions root.
    const codexThreads = new Map<string, Map<string, string>>();
    const codexIndex = async (rootPath: string) => {
      const known = codexThreads.get(rootPath);
      if (known) return known;
      const index = new Map<string, string>();
      codexThreads.set(rootPath, index);
      const pending = [rootPath];
      for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
        const entries = await fs.readdir(dir).catch(() => [] as Dirent[]);
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink()) continue;
          const child = join(dir, entry.name);
          if (entry.isDirectory()) pending.push(child);
          const native = entry.isFile()
            ? /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(entry.name)?.[1]
            : undefined;
          if (native && !index.has(native)) index.set(native, child);
        }
      }
      return index;
    };
    const codexParent = async (rollout: string, rootPath: string) => {
      const parentId = codexSessionMeta(rollout)?.parentId;
      return parentId ? (await codexIndex(codexSessionsRoot(rootPath))).get(parentId) : undefined;
    };
    const file = async (path: string, agent: IngestAgent, info: Stats, rootPath: string) => {
      if (agent !== "codex") {
        if (info.mtimeMs < since) return;
        return ingest(path, agent, () => fs.readFile(path));
      }
      if (info.mtimeMs < since) {
        // An older child is still re-ingested when its parent rollout changed since `since`, so it
        // links to a parent that appeared later (L6c). Reading it never writes or locks it.
        let rollout: string;
        try {
          rollout = await fs.readFile(path);
        } catch {
          return failure();
        }
        const parentPath = await codexParent(rollout, rootPath);
        const parent = parentPath ? await fs.lstat(parentPath).catch(() => null) : null;
        if (!parentPath || !parent || parent.mtimeMs < since) return;
        return ingest(path, agent, async () => createCodexDocument({ rollout, parentPath }));
      }
      await ingest(path, agent, async () => {
        const rollout = await fs.readFile(path);
        const parentPath = await codexParent(rollout, rootPath);
        return parentPath ? createCodexDocument({ rollout, parentPath }) : rollout;
      });
    };
    // One virtual source per session (`<root>/sessions/<id>`); the reader never writes or locks.
    const opencode = async (path: string) => {
      const result = await readOpenCodeSessions(path);
      for (let index = 0; index < result.failures; index++) failure();
      for (const session of result.sessions) {
        if (session.updated !== null && session.updated < since) continue;
        await ingest(session.path, "opencode", async () => session.content);
      }
    };
    /** Regular, non-symlink entries of one directory; an absent directory has none. */
    const files = async (path: string, suffix: string) => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") failure();
        return [];
      }
      const found: { name: string; path: string; info: Stats }[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink() || !entry.name.endsWith(suffix)) continue;
        const child = join(path, entry.name);
        try {
          const info = await fs.lstat(child);
          if (info.isFile()) found.push({ name: entry.name, path: child, info });
        } catch {
          failure();
        }
      }
      return found;
    };
    // Task records give only metadata (D4, L9); parents resolve by Pi's `<ts>_<id>.jsonl` name.
    const subagents = async (path: string, parents: string | undefined) => {
      for (const dir of ["sessions", "tasks"]) {
        const info = await fs.lstat(join(path, dir)).catch(() => null);
        if (info?.isSymbolicLink()) return;
        if (info && !info.isDirectory()) return failure();
      }
      const tasks = new Map<string, { task: GentleTaskRecord; mtimeMs: number }[]>();
      for (const file of await files(join(path, "tasks"), ".json")) {
        try {
          const record = readGentleTaskRecord(await fs.readFile(file.path));
          if (!record) throw new Error("invalid task record");
          const linked = tasks.get(record.sessionFile) ?? [];
          linked.push({ task: record.task, mtimeMs: file.info.mtimeMs });
          tasks.set(record.sessionFile, linked);
        } catch {
          failure();
        }
      }
      let parentPaths: Map<string, string> | undefined;
      const parentIndex = async () => {
        if (parentPaths) return parentPaths;
        parentPaths = new Map();
        const pending = parents ? [normalize(parents)] : [];
        for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
          const entries = await fs.readdir(dir).catch(() => [] as Dirent[]);
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isSymbolicLink()) continue;
            const child = join(dir, entry.name);
            if (entry.isDirectory()) pending.push(child);
            const native = entry.isFile()
              ? /_([A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl$/.exec(entry.name)?.[1]
              : undefined;
            if (native && !parentPaths.has(native)) parentPaths.set(native, child);
          }
        }
        return parentPaths;
      };
      const subagent = {
        version: GENTLE_SHELL_SUBAGENT_ADAPTER_VERSION,
        parse: parseGentleShellSubagent,
      };
      for (const file of await files(join(path, "sessions"), ".jsonl")) {
        const linked = tasks.get(file.name) ?? [];
        if (Math.max(file.info.mtimeMs, ...linked.map((task) => task.mtimeMs)) < since) continue;
        const index = linked.length > 0 ? await parentIndex() : new Map<string, string>();
        await ingest(
          file.path,
          "gentle-shell",
          async () =>
            createGentleSubagentDocument({
              session: await fs.readFile(file.path),
              tasks: linked.map(({ task }) => task),
              parentPaths: Object.fromEntries(
                linked.flatMap(({ task }) => {
                  const parent = index.get(task.parentSessionId);
                  return parent ? [[task.parentSessionId, parent]] : [];
                }),
              ),
            }),
          subagent,
          undefined, // `parsers["gentle-shell"]` overrides parent transcripts only.
        );
      }
    };
    const walk = async (path: string, agent: IngestAgent, rootPath = path): Promise<void> => {
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
          if (info.isDirectory()) await walk(child, agent, rootPath);
          else if (info.isFile() && child.endsWith(".jsonl"))
            await file(child, agent, info, rootPath);
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
        if (linked) continue;
        if (root.agent === "opencode") await opencode(path);
        else if (root.kind === "subagents" && !request.path) await subagents(path, root.parents);
        else await walk(path, root.agent);
      } catch (error) {
        if (!request.path && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
        failure();
      }
    }
    // Read-only git links of the sessions' repositories (Phase 4 L14); never counted in metrics.
    await syncGitRepos(db);
    // Derived: rewritten in full after every ingest, whatever changed (L10, Phase 4 L14 (3)).
    await recomputeProfileAttribution(db);
    await recomputeCommitAttribution(db);
    return metrics;
  });
}
