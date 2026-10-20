import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./database";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

export interface Migration {
  version: number;
  name: string;
  path: string;
}

export interface MigrateResult {
  applied: Migration[];
}

/** Lists numbered migrations (`NNN_name.sql`) in ascending order. Schema changes only land this way (spec §11.3). */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = FILE_PATTERN.exec(file);
      if (!match?.[1]) {
        throw new Error(`Invalid migration file name "${file}": expected NNN_snake_name.sql`);
      }
      return { version: Number(match[1]), name: file, path: join(dir, file) };
    })
    .sort((a, b) => a.version - b.version);

  for (let i = 1; i < migrations.length; i++) {
    const current = migrations[i];
    if (current && current.version === migrations[i - 1]?.version) {
      throw new Error(`Duplicate migration version ${current.version}`);
    }
  }
  return migrations;
}

/** Applies pending migrations, each one in its own transaction together with its ledger row. */
export async function migrate(db: Database, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  await db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )`,
  );
  const done = new Set(
    (await db.all<{ version: number }>("SELECT version FROM schema_migrations")).map((r) =>
      Number(r.version),
    ),
  );

  const applied: Migration[] = [];
  for (const migration of listMigrations(dir)) {
    if (done.has(migration.version)) continue;
    const sql = readFileSync(migration.path, "utf8");
    await db.run("BEGIN TRANSACTION");
    try {
      await db.run(sql);
      await db.run("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        migration.version,
        migration.name,
      ]);
      await db.run("COMMIT");
    } catch (error) {
      await db.run("ROLLBACK");
      throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
    applied.push(migration);
  }
  return { applied };
}
