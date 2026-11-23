-- Subscription rules may narrow a provider rule to one model (spec §5.1: the NaN Gentle plan meters
-- each model with its own allowance). NULL keeps the rule covering every model of the provider.
ALTER TABLE subscription_rules ADD COLUMN model VARCHAR;

-- Rebuilt with the model condition; semantics otherwise identical to 005.
CREATE OR REPLACE VIEW turn_subscriptions AS
SELECT
  t.id AS turn_id,
  (
    SELECT r.subscription_id
    FROM subscription_rules r
    JOIN subscriptions s ON s.id = r.subscription_id
    WHERE r.provider = t.provider
      AND (r.model IS NULL OR r.model = t.model)
      AND (r.agent IS NULL OR r.agent = se.agent)
      AND (s.started_at IS NULL OR CAST(t.ts AS DATE) >= s.started_at)
      AND (s.ended_at IS NULL OR CAST(t.ts AS DATE) <= s.ended_at)
    ORDER BY r.position
    LIMIT 1
  ) AS subscription_id
FROM turns t
LEFT JOIN sessions se ON se.id = t.session_id;
