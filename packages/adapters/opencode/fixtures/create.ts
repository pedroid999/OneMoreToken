import { copyFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const fixtures = new URL("./", import.meta.url);

/** Builds a synthetic OpenCode data dir in `dir` (a test temp directory): `opencode.db` plus a
 * non-empty `opencode.db-wal` holding every row (no `-shm`), and the legacy `storage/` tree with
 * one corrupt message file. Test-only helper: never point it at a real agent directory.
 */
export async function createOpenCodeFixture(
  dir: string,
  { sqlite = true, legacy = true }: { sqlite?: boolean; legacy?: boolean } = {},
): Promise<void> {
  if (sqlite) {
    const scratch = await mkdtemp(join(tmpdir(), "omt-opencode-fixture-"));
    try {
      const writer = new DatabaseSync(join(scratch, "opencode.db"));
      try {
        writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
        writer.exec(await readFile(new URL("opencode.sql", fixtures), "utf8"));
        // Copy while the writer is open so the rows stay in the WAL, as with a live OpenCode.
        await copyFile(join(scratch, "opencode.db"), join(dir, "opencode.db"));
        await copyFile(join(scratch, "opencode.db-wal"), join(dir, "opencode.db-wal"));
      } finally {
        writer.close();
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  if (legacy) {
    await cp(new URL("storage", fixtures), join(dir, "storage"), { recursive: true });
    await writeFile(
      join(dir, "storage", "message", "ses_legacy_only", "msg_l3.json"),
      '{"id":"msg_l3","role":"PRIVATE_SENTINEL',
    );
  }
}
