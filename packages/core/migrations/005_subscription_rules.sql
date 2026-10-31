-- Quota attribution is by subscription, not by agent (spec §4, §5): the user's local config says which
-- provider (and optionally which agent) each subscription covers. Rules are rewritten on every config
-- sync; `position` is the global match order (subscriptions in file order, then their rules).
CREATE TABLE subscription_rules (
  position INTEGER PRIMARY KEY,
  subscription_id VARCHAR NOT NULL,
  provider VARCHAR NOT NULL,
  agent VARCHAR
);

-- Derived at query time so editing the config never needs a re-ingest. Dates are inclusive and compared
-- with the turn's local calendar date; a turn without a matching rule is pay-as-you-go API usage (NULL).
CREATE VIEW turn_subscriptions AS
SELECT
  t.id AS turn_id,
  (
    SELECT r.subscription_id
    FROM subscription_rules r
    JOIN subscriptions s ON s.id = r.subscription_id
    WHERE r.provider = t.provider
      AND (r.agent IS NULL OR r.agent = se.agent)
      AND (s.started_at IS NULL OR CAST(t.ts AS DATE) >= s.started_at)
      AND (s.ended_at IS NULL OR CAST(t.ts AS DATE) <= s.ended_at)
    ORDER BY r.position
    LIMIT 1
  ) AS subscription_id
FROM turns t
LEFT JOIN sessions se ON se.id = t.session_id;
