-- Native sessions: device clock minus server clock at /v1/mobile/start (ms),
-- recorded when they disagree by more than the tolerance; startedAt is then the
-- server receive time. Additive + nullable -> instant, no table rewrite, existing
-- rows unaffected. Never filtered on, so no index.
ALTER TABLE "Session" ADD COLUMN "clockSkewMs" BIGINT;
