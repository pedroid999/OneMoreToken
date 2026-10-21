-- Whole-file snapshots: a matching hash AND adapter version can skip parsing (spec §3).
CREATE TABLE ingest_checkpoints (
  source_id VARCHAR PRIMARY KEY,
  content_hash VARCHAR NOT NULL,
  adapter_version VARCHAR NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL
);
