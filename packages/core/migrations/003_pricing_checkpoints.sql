-- Reprice unchanged sources when the reference catalog or pricing policy changes (spec §4).
-- NULL legacy checkpoints reparse once; the hash commits atomically with the source snapshot.
ALTER TABLE ingest_checkpoints ADD COLUMN pricing_hash VARCHAR DEFAULT NULL;
