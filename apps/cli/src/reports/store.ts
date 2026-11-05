import { join } from "node:path";
import { readUserText, userDirectory, writeUserText } from "../views/files";

/** A report is markdown text; anything bigger than this is not one of ours. */
const MAX_REPORT_BYTES = 1024 * 1024;

export interface ReportWrite {
  path: string;
  /** False when the bytes did not change: an idempotent pass never rewrites the file. */
  written: boolean;
}

/**
 * Writes `<directory>/<file>` with the private user-file rules (0700 directory, 0600 file, atomic
 * replace, never through a symlink) and skips the write when the content is already identical (L27).
 */
export async function writeReportFile(
  directory: string,
  file: string,
  text: string,
): Promise<ReportWrite> {
  await userDirectory(directory, true);
  const path = join(directory, file);
  const existing = await readUserText(directory, file, MAX_REPORT_BYTES);
  if (existing === text) return { path, written: false };
  await writeUserText(directory, file, text);
  return { path, written: true };
}
