import { PricingFileSchema } from "../data/files";
import type { Database } from "../db/database";
import { TABLE_SCHEMAS } from "../schema/tables";
import {
  createSource,
  hashContent,
  NormalizedBatchSchema,
  type ParseContext,
  type SourceParser,
} from "./batch";

export interface IngestCheckpoint {
  source_id: string;
  content_hash: string;
  adapter_version: string;
  pricing_hash: string | null;
  ingested_at: string;
}

export async function getCheckpoint(
  db: Database,
  sourceId: string,
): Promise<IngestCheckpoint | null> {
  const rows = await db.all<IngestCheckpoint & Record<string, unknown>>(
    `SELECT source_id, content_hash, adapter_version, pricing_hash,
      strftime(ingested_at AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%S.%gZ') AS ingested_at
     FROM ingest_checkpoints WHERE source_id = $1`,
    [sourceId],
  );
  return rows[0] ?? null;
}

/** The caller serializes writer operations on this connection (spec §11.1).
 * Validates the complete snapshot before BEGIN; no files are opened or modified.
 */
export async function persistBatch(
  db: Database,
  input: unknown,
  contentHash: string,
  pricingHash: string | null = null,
): Promise<void> {
  const batch = NormalizedBatchSchema.parse(input);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) throw new Error("Invalid content hash");
  if (pricingHash !== null && !/^[a-f0-9]{64}$/.test(pricingHash))
    throw new Error("Invalid pricing hash");
  const sourceId = batch.source.id;
  await db.run("BEGIN TRANSACTION");
  try {
    const sessions = "SELECT id FROM sessions WHERE source_id = $1";
    const turns = `SELECT id FROM turns WHERE session_id IN (${sessions})`;
    for (const table of ["usage", "tool_calls", "turn_profile"]) {
      await db.run(`DELETE FROM ${table} WHERE turn_id IN (${turns})`, [sourceId]);
    }
    await db.run(`DELETE FROM subagent_runs WHERE parent_session_id IN (${sessions})`, [sourceId]);
    await db.run(`DELETE FROM turns WHERE session_id IN (${sessions})`, [sourceId]);
    for (const table of ["sessions", "ingest_issues"]) {
      await db.run(`DELETE FROM ${table} WHERE source_id = $1`, [sourceId]);
    }
    await db.run("DELETE FROM sources WHERE id = $1", [sourceId]);
    for (const [table, rows] of [
      ["sources", [batch.source]],
      ["sessions", batch.sessions],
      ["turns", batch.turns],
      ["usage", batch.usage],
      ["tool_calls", batch.toolCalls],
      ["ingest_issues", batch.issues],
    ] as const) {
      const columns = Object.keys(TABLE_SCHEMAS[table].shape);
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
      for (const row of rows) {
        const values = row as Record<string, string | number | null>;
        await db.run(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
          columns.map((column) => values[column] ?? null),
        );
      }
    }
    await db.run(
      `INSERT INTO ingest_checkpoints (source_id, content_hash, adapter_version, ingested_at, pricing_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (source_id) DO UPDATE SET content_hash = excluded.content_hash,
         adapter_version = excluded.adapter_version, ingested_at = excluded.ingested_at,
         pricing_hash = excluded.pricing_hash`,
      [
        sourceId,
        contentHash,
        batch.source.adapter_version,
        batch.source.last_ingested_at,
        pricingHash,
      ],
    );
    await db.run("COMMIT");
  } catch (error) {
    try {
      await db.run("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

/** Skip only when content, adapter and validated pricing match the committed snapshot. */
export async function ingestSource(
  db: Database,
  content: string,
  context: ParseContext,
  parse: SourceParser,
): Promise<"skipped" | "persisted"> {
  const source = createSource(context);
  const hash = hashContent(content);
  // Zod emits known fields in schema order, canonicalizing JSON object key order and whitespace.
  const pricing = PricingFileSchema.parse(context.pricing);
  const pricingHash = hashContent(JSON.stringify(pricing));
  const checkpoint = await getCheckpoint(db, source.id);
  if (
    checkpoint?.content_hash === hash &&
    checkpoint.adapter_version === context.adapterVersion &&
    checkpoint.pricing_hash === pricingHash
  ) {
    return "skipped";
  }
  const batch = NormalizedBatchSchema.parse(parse(content, { ...context, pricing }));
  if (JSON.stringify(batch.source) !== JSON.stringify(source)) {
    throw new Error("Parser returned a different source");
  }
  await persistBatch(db, batch, hash, pricingHash);
  return "persisted";
}
