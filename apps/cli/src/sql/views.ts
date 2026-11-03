import { readdir } from "node:fs/promises";
import {
  MAX_SAVED_QUERY_BYTES,
  SAVED_QUERY_ID,
  type SavedQuery,
  SavedQueryInputSchema,
  SavedQuerySchema,
} from "@omt/core";
import {
  readUserJson,
  removeUserFile,
  UnsafeStorageError,
  userDirectory,
  writeUserJson,
} from "../views/files";

export interface SavedQueryList {
  views: SavedQuery[];
  /** Files that are unreadable, symlinked, invalid or whose id does not match their name. */
  invalid: { id: string }[];
}

const MESSAGES = {
  400: "invalid saved query",
  404: "saved query not found",
  409: "unsafe sql view storage",
} as const;
/** Safe, fixed diagnostics: never paths or exception details. */
export class SavedQueryError extends Error {
  constructor(readonly status: keyof typeof MESSAGES) {
    super(MESSAGES[status]);
  }
}

export interface SavedQueryStoreOptions {
  /** `${XDG_DATA_HOME:-~/.local/share}/one-more-token/sql-views`. */
  directory: string;
  /** Clock for `updatedAt`; tests pin it. */
  now?: () => Date;
}

export interface SavedQueryStore {
  list(): Promise<SavedQueryList>;
  put(id: string, input: unknown): Promise<SavedQuery>;
  remove(id: string): Promise<void>;
}

/** Saved queries are private files that never follow symlinks; writes are serialized. */
export function createSavedQueryStore(options: SavedQueryStoreOptions): SavedQueryStore {
  const { directory } = options;
  const now = options.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  /** Storage that is not a plain directory or file is refused, never followed. */
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UnsafeStorageError) throw new SavedQueryError(409);
      throw error;
    }
  }

  async function readUser(id: string): Promise<SavedQuery | null> {
    const stored = await readUserJson(directory, id, MAX_SAVED_QUERY_BYTES);
    if (stored === null) return null;
    const parsed = SavedQuerySchema.safeParse(stored);
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  return {
    async list() {
      const views: SavedQuery[] = [];
      const invalid: SavedQueryList["invalid"] = [];
      if (await storage(() => userDirectory(directory, false))) {
        const ids = (await readdir(directory))
          .filter((file) => /^[a-z0-9-]{1,64}\.json$/.test(file))
          .map((file) => file.slice(0, -".json".length))
          .sort();
        for (const id of ids) {
          const view = await readUser(id);
          if (view) views.push(view);
          else invalid.push({ id });
        }
      }
      return { views, invalid };
    },

    async put(id, input) {
      if (!SAVED_QUERY_ID.test(id)) throw new SavedQueryError(400);
      const parsed = SavedQueryInputSchema.safeParse(input);
      if (!parsed.success) throw new SavedQueryError(400);
      const view: SavedQuery = {
        schema: "omt.saved-query/1",
        id,
        name: parsed.data.name,
        sql: parsed.data.sql,
        updatedAt: now().toISOString(),
      };
      const text = `${JSON.stringify(view, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_SAVED_QUERY_BYTES) throw new SavedQueryError(400);
      return serialize(() =>
        storage(async () => {
          await userDirectory(directory, true);
          await writeUserJson(directory, id, text);
          return view;
        }),
      );
    },

    async remove(id) {
      if (!SAVED_QUERY_ID.test(id)) throw new SavedQueryError(400);
      return serialize(() =>
        storage(async () => {
          if (!(await userDirectory(directory, false))) throw new SavedQueryError(404);
          if (!(await removeUserFile(directory, id))) throw new SavedQueryError(404);
        }),
      );
    },
  };
}
