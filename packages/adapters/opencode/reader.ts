import { constants, type Dirent } from "node:fs";
import { copyFile, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  compareByTime,
  OPENCODE_DOCUMENT_FORMAT,
  OPENCODE_ID,
  type OpenCodeDocument,
  type OpenCodeMessage,
  type OpenCodePart,
  type OpenCodeSessionInfo,
  object,
  projectMessage,
  projectPart,
} from "./document";

/** One canonical document per session, at the virtual path `<root>/sessions/<sessionId>`. */
export interface OpenCodeSessionSource {
  path: string;
  /** Session updated time (epoch ms), used by `since`; null when unknown. */
  updated: number | null;
  content: string;
}
export interface OpenCodeReadResult {
  sessions: OpenCodeSessionSource[];
  /** Unreadable database or legacy session files; never details or content. */
  failures: number;
}
export interface OpenCodeReaderOptions {
  /** Parent of the private database copy (default: the OS temp directory). */
  tmpdir?: string;
  copyFile?: (source: string, target: string, mode?: number) => Promise<void>;
}

type Entry = { time: number | null; id: string; message: OpenCodeMessage | null };
const DATABASE = "opencode.db";
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const text = (value: unknown) => (typeof value === "string" ? value : null);

/** Absent → null; a symlink is not followed and counts as absent, like other ingest roots. */
async function regular(path: string) {
  try {
    const info = await lstat(path);
    return info.isSymbolicLink() ? null : info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function document(
  origin: OpenCodeDocument["origin"],
  session: OpenCodeSessionInfo,
  entries: Entry[],
  root: string,
): OpenCodeSessionSource {
  entries.sort(compareByTime);
  const doc: OpenCodeDocument = {
    format: OPENCODE_DOCUMENT_FORMAT,
    origin,
    session,
    messages: entries.map((entry) => entry.message),
  };
  return {
    path: join(root, "sessions", session.id),
    updated: session.updated,
    content: JSON.stringify(doc),
  };
}

/** Reads the live database without touching it: opening it, even read-only, would take read
 * marks in `-shm`, and `immutable=1` ignores the WAL. Instead `opencode.db` and its `-wal`
 * (never `-shm`) are copied into a private temp directory, retried once if either changed
 * during the copy, and only the copy is opened. The directory is removed afterwards.
 */
async function readDatabase(
  root: string,
  options: OpenCodeReaderOptions,
  result: OpenCodeReadResult,
): Promise<void> {
  const files = [DATABASE, `${DATABASE}-wal`];
  const fingerprint = async () =>
    (await Promise.all(files.map((name) => regular(join(root, name))))).map((info) =>
      info ? `${info.size}:${info.mtimeMs}` : "absent",
    );
  const copy = options.copyFile ?? copyFile;
  const dir = await mkdtemp(join(options.tmpdir ?? tmpdir(), "omt-opencode-"));
  try {
    let copied = false;
    for (let attempt = 0; attempt < 2 && !copied; attempt++) {
      const before = await fingerprint();
      for (const [index, name] of files.entries()) {
        if (before[index] !== "absent")
          await copy(join(root, name), join(dir, name), constants.COPYFILE_FICLONE);
      }
      copied = JSON.stringify(await fingerprint()) === JSON.stringify(before);
    }
    if (!copied) throw new Error("database changed during copy");
    const db = new DatabaseSync(join(dir, DATABASE), { readOnly: true });
    try {
      const sessions = new Map<string, { info: OpenCodeSessionInfo; entries: Entry[] }>();
      for (const row of db
        .prepare(
          "SELECT id, parent_id, directory, version, time_created, time_updated FROM session",
        )
        .iterate()) {
        const id = text(row.id);
        if (!id || !OPENCODE_ID.test(id)) {
          result.failures++;
          continue;
        }
        sessions.set(id, {
          info: {
            id,
            parentId: text(row.parent_id),
            directory: text(row.directory),
            version: text(row.version),
            created: finite(row.time_created),
            updated: finite(row.time_updated),
          },
          entries: [],
        });
      }
      const messages = new Map<string, OpenCodeMessage>();
      for (const row of db
        .prepare("SELECT id, session_id, time_created, data FROM message")
        .iterate()) {
        const session = sessions.get(String(row.session_id));
        const id = String(row.id);
        if (!session) continue;
        const data = parseJson(String(row.data));
        const message = data === undefined ? null : projectMessage(id, data);
        if (message) messages.set(id, message);
        session.entries.push({
          time: message?.time.created ?? finite(row.time_created),
          id,
          message,
        });
      }
      for (const row of db
        .prepare("SELECT id, message_id, data FROM part ORDER BY message_id, id")
        .iterate()) {
        const message = messages.get(String(row.message_id));
        if (!message) continue;
        const data = parseJson(String(row.data));
        const part = data === undefined ? null : projectPart(data);
        if (part !== undefined) message.parts.push(part);
      }
      for (const { info, entries } of [...sessions.values()].sort((a, b) =>
        a.info.id < b.info.id ? -1 : 1,
      ))
        result.sessions.push(document("sqlite", info, entries, root));
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Regular `*.json` files of a directory (symlinks skipped), sorted by name. */
async function jsonFiles(dir: string, recursive = false): Promise<string[]> {
  if (!(await regular(dir))?.isDirectory()) return [];
  const entries: Dirent[] = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && recursive) files.push(...(await jsonFiles(path, true)));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

async function readLegacy(
  root: string,
  skip: ReadonlySet<string>,
  result: OpenCodeReadResult,
): Promise<void> {
  const storage = join(root, "storage");
  if (!(await regular(storage))?.isDirectory()) return;
  for (const file of await jsonFiles(join(storage, "session"), true)) {
    let info: OpenCodeSessionInfo;
    try {
      const raw = object(JSON.parse(await readFile(file, "utf8")));
      const id = text(raw.id);
      if (!id || !OPENCODE_ID.test(id)) throw new Error("invalid session id");
      const time = object(raw.time);
      info = {
        id,
        parentId: text(raw.parentID),
        directory: text(raw.directory),
        version: text(raw.version),
        created: finite(time.created),
        updated: finite(time.updated),
      };
    } catch {
      result.failures++;
      continue;
    }
    if (skip.has(info.id)) continue;
    try {
      const entries: Entry[] = [];
      for (const path of await jsonFiles(join(storage, "message", info.id))) {
        const name = basename(path, ".json");
        const data = parseJson(await readFile(path, "utf8"));
        const id = text(object(data).id) ?? name;
        if (data === undefined || !OPENCODE_ID.test(id)) {
          entries.push({ time: null, id: name, message: null });
          continue;
        }
        const message = projectMessage(id, data);
        for (const partPath of await jsonFiles(join(storage, "part", id))) {
          const part = parseJson(await readFile(partPath, "utf8"));
          const projected: OpenCodePart | null | undefined =
            part === undefined ? null : projectPart(part);
          if (projected !== undefined) message.parts.push(projected);
        }
        entries.push({ time: message.time.created, id, message });
      }
      result.sessions.push(document("legacy", info, entries, root));
    } catch {
      result.failures++;
    }
  }
}

/** Metrics-only, lock-free snapshot of an OpenCode data directory (spec §3; L9-L10).
 * SQLite wins: a legacy `storage/` session is read only when the database lacks its id or the
 * database is absent. An unreadable database also skips legacy sessions to avoid double counts.
 */
export async function readOpenCodeSessions(
  root: string,
  options: OpenCodeReaderOptions = {},
): Promise<OpenCodeReadResult> {
  const result: OpenCodeReadResult = { sessions: [], failures: 0 };
  let skip = new Set<string>();
  if (await regular(join(root, DATABASE))) {
    try {
      await readDatabase(root, options, result);
      skip = new Set(result.sessions.map((session) => basename(session.path)));
    } catch {
      result.sessions = [];
      result.failures++;
      return result;
    }
  }
  try {
    await readLegacy(root, skip, result);
  } catch {
    result.failures++;
  }
  return result;
}
