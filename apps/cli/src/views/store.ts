import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { loadPresetViews, SAVED_VIEW_ID, type SavedView, SavedViewSchema } from "@omt/core";

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

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

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

  /** False when absent and not created; a symlink or non-directory is unsafe. */
  async function userDirectory(create: boolean): Promise<boolean> {
    try {
      const stats = await lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new ViewError(409);
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return false;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return userDirectory(create);
    }
    if (create) await chmod(directory, 0o700);
    return true;
  }

  async function readUserView(id: string): Promise<SavedView | null> {
    try {
      const handle = await open(
        join(directory, `${id}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_VIEW_BYTES) return null;
        const view = SavedViewSchema.parse(JSON.parse(await handle.readFile("utf8")));
        return view.id === id ? view : null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  function checkId(id: string, presetIds: Set<string>): void {
    if (!SAVED_VIEW_ID.test(id)) throw new ViewError(400);
    if (presetIds.has(id)) throw new ViewError(403);
  }

  return {
    async list() {
      const views: ViewEntry[] = presets().map((view) => ({ origin: "preset", ...view }));
      const presetIds = new Set(views.map((view) => view.id));
      const invalid: ViewList["invalid"] = [];
      if (await userDirectory(false)) {
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
      return serialize(async () => {
        await userDirectory(true);
        const target = join(directory, `${id}.json`);
        try {
          const stats = await lstat(target);
          if (stats.isSymbolicLink() || !stats.isFile()) throw new ViewError(409);
        } catch (error) {
          if (!missing(error)) throw error;
        }
        // Atomic replace: a private temp file in the same directory, then rename over the target.
        const temp = join(directory, `.${id}.${randomUUID()}.tmp`);
        const handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          try {
            await handle.writeFile(text);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await rename(temp, target);
        } catch (error) {
          await unlink(temp).catch(() => {});
          throw error;
        }
        return { origin: "user" as const, ...parsed.data };
      });
    },

    async remove(id) {
      checkId(id, new Set(presets().map((view) => view.id)));
      return serialize(async () => {
        if (!(await userDirectory(false))) throw new ViewError(404);
        const target = join(directory, `${id}.json`);
        try {
          const stats = await lstat(target);
          if (stats.isSymbolicLink() || !stats.isFile()) throw new ViewError(409);
        } catch (error) {
          if (missing(error)) throw new ViewError(404);
          throw error;
        }
        await unlink(target);
      });
    },
  };
}
