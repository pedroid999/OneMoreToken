-- Initial normalized schema (spec §4).
-- Ids are deterministic strings produced by adapters, so re-ingesting the same data upserts
-- instead of duplicating rows (spec §3, idempotency). No foreign keys: DuckDB cannot upsert
-- parent rows that are referenced, and integrity is enforced by Zod at ingest time.

CREATE TABLE sources (
  id VARCHAR PRIMARY KEY,
  agent VARCHAR NOT NULL,
  path VARCHAR NOT NULL,
  adapter_version VARCHAR NOT NULL,
  last_ingested_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id VARCHAR PRIMARY KEY,
  source_id VARCHAR NOT NULL,
  agent VARCHAR NOT NULL,
  cwd VARCHAR,
  repo VARCHAR,
  branch VARCHAR,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  title VARCHAR,
  format_version VARCHAR NOT NULL
);

CREATE TABLE turns (
  id VARCHAR PRIMARY KEY,
  session_id VARCHAR NOT NULL,
  idx INTEGER NOT NULL,
  role VARCHAR NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  model VARCHAR,
  provider VARCHAR,
  effort VARCHAR,
  subscription_id VARCHAR
);

CREATE TABLE usage (
  turn_id VARCHAR PRIMARY KEY,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  reported_cost_usd DOUBLE,
  computed_cost_usd DOUBLE
);

CREATE TABLE tool_calls (
  id VARCHAR PRIMARY KEY,
  turn_id VARCHAR NOT NULL,
  tool VARCHAR NOT NULL,
  duration_ms BIGINT,
  status VARCHAR NOT NULL CHECK (status IN ('ok', 'error'))
);

CREATE TABLE subagent_runs (
  id VARCHAR PRIMARY KEY,
  parent_session_id VARCHAR NOT NULL,
  role VARCHAR NOT NULL,
  model VARCHAR,
  provider VARCHAR,
  effort VARCHAR,
  started_at TIMESTAMPTZ,
  duration_ms BIGINT,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  reported_cost_usd DOUBLE,
  computed_cost_usd DOUBLE
);

CREATE TABLE profiles (
  hash VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  definition JSON NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE turn_profile (
  turn_id VARCHAR PRIMARY KEY,
  profile_hash VARCHAR NOT NULL,
  attribution VARCHAR NOT NULL CHECK (attribution IN ('exact', 'estimated'))
);

CREATE TABLE pricing (
  model VARCHAR NOT NULL,
  provider VARCHAR NOT NULL,
  valid_from DATE NOT NULL,
  valid_to DATE,
  input_per_mtok DOUBLE NOT NULL,
  output_per_mtok DOUBLE NOT NULL,
  cache_read_per_mtok DOUBLE NOT NULL,
  cache_write_per_mtok DOUBLE NOT NULL,
  PRIMARY KEY (model, provider, valid_from)
);

CREATE TABLE subscriptions (
  id VARCHAR PRIMARY KEY,
  plan_id VARCHAR NOT NULL,
  provider VARCHAR NOT NULL,
  label VARCHAR NOT NULL,
  started_at DATE,
  ended_at DATE
);

CREATE TABLE quota_windows (
  id VARCHAR PRIMARY KEY,
  subscription_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('five_hours', 'weekly', 'monthly')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  used_tokens BIGINT NOT NULL DEFAULT 0,
  used_usd DOUBLE NOT NULL DEFAULT 0,
  limit_usd DOUBLE,
  estimated_pct DOUBLE
);

CREATE TABLE calibrations (
  id VARCHAR PRIMARY KEY,
  subscription_id VARCHAR NOT NULL,
  window_kind VARCHAR NOT NULL CHECK (window_kind IN ('five_hours', 'weekly', 'monthly')),
  observed_at TIMESTAMPTZ NOT NULL,
  observed_pct DOUBLE NOT NULL CHECK (observed_pct >= 0),
  note VARCHAR
);

CREATE TABLE commits (
  repo VARCHAR NOT NULL,
  sha VARCHAR NOT NULL,
  authored_at TIMESTAMPTZ NOT NULL,
  author VARCHAR,
  message VARCHAR,
  additions INTEGER,
  deletions INTEGER,
  PRIMARY KEY (repo, sha)
);

CREATE TABLE ingest_issues (
  id VARCHAR PRIMARY KEY,
  source_id VARCHAR,
  path VARCHAR,
  location VARCHAR,
  severity VARCHAR NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
  code VARCHAR NOT NULL,
  message VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
