-- Child sessions (subagents, subtasks) point at their parent; compaction turns mark context resets (spec §7.1).
-- Existing rows keep no parent and no compaction until their source is re-ingested.
-- DuckDB cannot add a constrained column, nor SET NOT NULL over existing rows inside the migration
-- transaction: the default backfills false and the Zod batch contract requires a boolean on write.
ALTER TABLE sessions ADD COLUMN parent_session_id VARCHAR DEFAULT NULL;
ALTER TABLE turns ADD COLUMN is_compaction BOOLEAN DEFAULT false;
