import { readdir } from "node:fs/promises";
import { loadPresetViews, SAVED_VIEW_ID, type SavedView, SavedViewSchema } from "@omt/core";
import {
  readUserJson,
  removeUserFile,
  UnsafeStorageError,
  userDirectory,
  writeUserJson,
} from "./files";

/** Per-file limit for user views (L16), applied to the request body and the stored file. */
export const MAX_VIEW_BYTES = 256 * 1024;

export type ViewEntry = SavedView & { origin: "preset" | "user" };
export interface ViewList {
  views: ViewEntry[];
  /** User files named `<id>.json` that are unreadable, symlinked, invalid or misnamed. */
  invalid: { id: string }[];
}

const MESSAGES = {
  400: "invalid view",
  403: "preset views are read-only",
  404: "view not found",
  409: "unsafe view storage",
} as const;
/** Safe, fixed diagnostics: never paths or exception details. */
export class ViewError extends Error {
  constructor(readonly status: keyof typeof MESSAGES) {
    super(MESSAGES[status]);
  }
}

export interface ViewStoreOptions {
  /** User views directory, e.g. `${XDG_DATA_HOME:-~/.local/share}/one-more-token/views`. */
  directory: string;
  /** Defaults to the versioned `data/views`. */
  presetsDirectory?: string;
}

export interface ViewStore {
  list(): Promise<ViewList>;
  put(id: string, input: unknown): Promise<ViewEntry>;
  remove(id: string): Promise<void>;
}

/** Presets are read-only; user views are private files that never follow symlinks. */
export function createViewStore(options: ViewStoreOptions): ViewStore {
  const { directory } = options;
  const presets = () => loadPresetViews(options.presetsDirectory);
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };

  async function readUserView(id: string): Promise<SavedView | null> {
    const stored = await readUserJson(directory, id, MAX_VIEW_BYTES);
    if (stored === null) return null;
    const parsed = SavedViewSchema.safeParse(stored);
    return parsed.success && parsed.data.id === id ? parsed.data : null;
  }

  function checkId(id: string, presetIds: Set<string>): void {
    if (!SAVED_VIEW_ID.test(id)) throw new ViewError(400);
    if (presetIds.has(id)) throw new ViewError(403);
  }

  /** Storage that is not a plain directory or file is refused, never followed. */
  async function storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UnsafeStorageError) throw new ViewError(409);
      throw error;
    }
  }

  return {
    async list() {
      const views: ViewEntry[] = presets().map((view) => ({ origin: "preset", ...view }));
      const presetIds = new Set(views.map((view) => view.id));
      const invalid: ViewList["invalid"] = [];
      if (await storage(() => userDirectory(directory, false))) {
        const ids = (await readdir(directory))
          .filter((file) => /^[a-z0-9-]{1,64}\.json$/.test(file))
          .map((file) => file.slice(0, -".json".length))
          .sort();
        for (const id of ids) {
          const view = presetIds.has(id) ? null : await readUserView(id);
          if (view) views.push({ origin: "user", ...view });
          else invalid.push({ id });
        }
      }
      return { views, invalid };
    },

    async put(id, input) {
      checkId(id, new Set(presets().map((view) => view.id)));
      const parsed = SavedViewSchema.safeParse(input);
      if (!parsed.success || parsed.data.id !== id) throw new ViewError(400);
      const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_VIEW_BYTES) throw new ViewError(400);
      return serialize(() =>
        storage(async () => {
          await userDirectory(directory, true);
          await writeUserJson(directory, id, text);
          return { origin: "user" as const, ...parsed.data };
        }),
      );
    },

    async remove(id) {
      checkId(id, new Set(presets().map((view) => view.id)));
      return serialize(() =>
        storage(async () => {
          if (!(await userDirectory(directory, false))) throw new ViewError(404);
          if (!(await removeUserFile(directory, id))) throw new ViewError(404);
        }),
      );
    },
  };
}
