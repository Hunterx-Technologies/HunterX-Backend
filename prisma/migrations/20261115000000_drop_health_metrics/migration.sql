-- Health data is no longer stored on the server. The app reads steps, sleep,
-- heart rate etc. straight from Apple Health / Health Connect on the phone
-- for every Metrics view (Today / Week / Month / Year), and nothing on the
-- backend used these tables except the "health data stopped syncing"
-- reminder, which is removed with them.
--
-- health_metrics was an older, unused table; health_metrics_daily held the
-- daily uploads. Both go, with every row in them, and the enum only
-- health_metrics used.

DROP TABLE IF EXISTS "health_metrics_daily";
DROP TABLE IF EXISTS "health_metrics";
DROP TYPE IF EXISTS "health_source";
