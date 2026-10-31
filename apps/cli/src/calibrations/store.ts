import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CalibrationEntry,
  CalibrationEntrySchema,
  type CalibrationsFile,
  CalibrationsFileSchema,
} from "@omt/core";

/** Upper bound for the request body and for the stored file. */
export const MAX_CALIBRATION_BODY_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Clock skew tolerated between the browser and the server for `observedAt`. */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const MESSAGES = {
  400: "invalid calibration",
  404: "calibration not found",
  409: "unsafe calibration storage",
} as const;
/** Safe, fixed diagnostics: never paths or exception details. */
export class CalibrationError extends Error {
  constructor(readonly status: keyof typeof MESSAGES) {
    super(MESSAGES[status]);
  }
}

/** Which window kinds each configured subscription accepts; null when the config is invalid. */
export type AllowedWindows = () => Map<string, ReadonlySet<string>> | null;

export interface CalibrationStore {
  list(): Promise<CalibrationEntry[]>;
  add(input: unknown): Promise<CalibrationEntry>;
  remove(id: string): Promise<CalibrationEntry[]>;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const InputSchema = CalibrationEntrySchema.omit({ id: true });

/**
 * One private file that is never followed through a symlink and never overwritten when it cannot be
 * read back as valid calibrations: the readings are user data that nothing else can rebuild.
 */
export function createCalibrationStore(
  path: string,
  allowed: AllowedWindows,
  now = () => Date.now(),
): CalibrationStore {
  const directory = dirname(path);
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };

  async function read(): Promise<CalibrationsFile> {
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return { version: 1, calibrations: [] };
      throw new CalibrationError(409);
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) throw new CalibrationError(409);
      const parsed = CalibrationsFileSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
      if (!parsed.success) throw new CalibrationError(409);
      return parsed.data;
    } catch (error) {
      throw error instanceof CalibrationError ? error : new CalibrationError(409);
    } finally {
      await handle.close();
    }
  }

  async function write(file: CalibrationsFile): Promise<void> {
    try {
      const stats = await lstat(directory);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new CalibrationError(409);
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await chmod(directory, 0o700);
    // Atomic replace: a private temp file in the same directory, then rename over the target.
    const temp = join(directory, `.calibrations.${randomUUID()}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  return {
    async list() {
      return (await read()).calibrations;
    },

    add(input) {
      const parsed = InputSchema.safeParse(input);
      if (!parsed.success) return Promise.reject(new CalibrationError(400));
      const windows = allowed()?.get(parsed.data.subscriptionId);
      if (!windows?.has(parsed.data.windowKind)) return Promise.reject(new CalibrationError(400));
      if (Date.parse(parsed.data.observedAt) > now() + FUTURE_TOLERANCE_MS) {
        return Promise.reject(new CalibrationError(400));
      }
      return serialize(async () => {
        const file = await read();
        const entry: CalibrationEntry = { id: randomUUID(), ...parsed.data };
        await write({ version: 1, calibrations: [...file.calibrations, entry] });
        return entry;
      });
    },

    remove(id) {
      return serialize(async () => {
        const file = await read();
        const kept = file.calibrations.filter((entry) => entry.id !== id);
        if (kept.length === file.calibrations.length) throw new CalibrationError(404);
        await write({ version: 1, calibrations: kept });
        return kept;
      });
    },
  };
}
