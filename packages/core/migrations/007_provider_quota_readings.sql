-- Quota readings reported by the provider inside agent data (spec §5.3, Phase 4 D2): Codex
-- `rate_limits` give the % used of the 5 h and weekly windows. They are derived from agent sources,
-- so they live here, owned by their source and rewritten with it on every re-ingest, never in the
-- user's calibrations file. Additive only: no existing table changes.
CREATE TABLE provider_quota_readings (
  id VARCHAR PRIMARY KEY,
  source_id VARCHAR NOT NULL,
  origin VARCHAR NOT NULL CHECK (origin IN ('codex')),
  window_kind VARCHAR NOT NULL CHECK (window_kind IN ('five_hours', 'weekly')),
  observed_at TIMESTAMPTZ NOT NULL,
  observed_pct DOUBLE NOT NULL CHECK (observed_pct >= 0 AND observed_pct <= 100),
  resets_at TIMESTAMPTZ NOT NULL
);
