-- Git links (spec §4, §7.1, Phase 4 L13/L14). Additive only: `commits` (migration 001) keeps the
-- user's commits; these tables link them to sessions, pull requests and turns.

-- The repository (toplevel path) of each session, resolved from its cwd or inherited from its
-- parent. Kept when the directory later disappears, like the commits of that repository.
CREATE TABLE session_repos (
  session_id VARCHAR PRIMARY KEY,
  repo VARCHAR NOT NULL
);

-- Pull request of a stored commit, inferred from a local `Merge pull request #N` merge commit.
CREATE TABLE commit_pull_requests (
  repo VARCHAR NOT NULL,
  sha VARCHAR NOT NULL,
  pr_number INTEGER NOT NULL CHECK (pr_number > 0),
  PRIMARY KEY (repo, sha)
);

-- Derived: the commit each turn is attributed to, rewritten in full after every ingest. Orphan
-- turns (no commit) have no row.
CREATE TABLE turn_commits (
  turn_id VARCHAR PRIMARY KEY,
  repo VARCHAR NOT NULL,
  sha VARCHAR NOT NULL
);
