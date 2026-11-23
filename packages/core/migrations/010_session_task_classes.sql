-- Corrected task class per session (spec §7.3, phase 5 L3). Additive only: it is user data, never
-- written by ingest, so a correction survives a re-ingest of the same session.
-- The derived class is computed at query time; `unknown` is never stored, it is the absence of a
-- correction and of positive evidence.
CREATE TABLE session_task_classes (
  session_id VARCHAR PRIMARY KEY,
  task_class VARCHAR NOT NULL CHECK (task_class IN ('feature', 'inline')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
);
