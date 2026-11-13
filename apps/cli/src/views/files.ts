import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Private user files under the data home: explorer settings and saved SQL queries share the same
 * rules (L16, T4). Nothing here ever follows a symlink or writes outside `directory`.
 */
export class UnsafeStorageError extends Error {
  constructor() {
    super("unsafe storage");
  }
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** False when the directory is absent and `create` is false; creates it 0700 when asked. */
export async function userDirectory(directory: string, create: boolean): Promise<boolean> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new UnsafeStorageError();
  } catch (error) {
    if (error instanceof UnsafeStorageError || !missing(error)) throw error;
    if (!create) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return userDirectory(directory, create);
  }
  if (create) await chmod(directory, 0o700);
  return true;
}

/** Parsed JSON of `<id>.json`, or null when absent, unsafe, oversized, unreadable or not JSON. */
export async function readUserJson(
  directory: string,
  id: string,
  maxBytes: number,
): Promise<unknown> {
  const text = await readUserText(directory, `${id}.json`, maxBytes);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Text of `file` inside `directory`, or null when absent, unsafe, oversized or unreadable. */
export async function readUserText(
  directory: string,
  file: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maxBytes) return null;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** Atomic replace: a private temp file in the same directory, then rename over the target. */
export async function writeUserJson(directory: string, id: string, text: string): Promise<void> {
  await writeUserText(directory, `${id}.json`, text);
}

/** Same atomic replace for any private user file (`<file>` is the complete file name). */
export async function writeUserText(directory: string, file: string, text: string): Promise<void> {
  const target = join(directory, file);
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new UnsafeStorageError();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temp = join(directory, `.${file}.${randomUUID()}.tmp`);
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
}

/** False when the file is absent; throws UnsafeStorageError for a symlink or a non-file. */
export async function removeUserFile(directory: string, id: string): Promise<boolean> {
  const target = join(directory, `${id}.json`);
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new UnsafeStorageError();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
  await unlink(target);
  return true;
}
