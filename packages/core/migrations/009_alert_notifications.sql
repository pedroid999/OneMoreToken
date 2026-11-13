CREATE TABLE alert_notifications (
  alert_id VARCHAR NOT NULL,
  subscription_id VARCHAR NOT NULL,
  kind VARCHAR NOT NULL CHECK (kind IN ('five_hours', 'weekly', 'monthly')),
  window_start TIMESTAMPTZ NOT NULL,
  threshold_pct DOUBLE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (alert_id, window_start)
);
