-- Exact profile attribution (spec §6.2): the gentle-shell session profile bound when each turn was
-- recorded, as parsed from `gentle-pi.session-profile/v1` entries. Owned by the turn's source and
-- rewritten with it, so `turn_profile` can be recomputed in full without reparsing unchanged files.
-- Turns with no binding (never bound, cleared, invalid entry) have no row.
CREATE TABLE turn_profile_bindings (
  turn_id VARCHAR PRIMARY KEY,
  profile_hash VARCHAR NOT NULL
);
