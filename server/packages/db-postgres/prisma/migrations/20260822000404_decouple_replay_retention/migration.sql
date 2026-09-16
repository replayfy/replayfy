-- Retention decoupling: analytics are now kept indefinitely; retention age-out
-- prunes only the WATCHABLE replay (Mongo rrweb blobs + R2 frames) and stamps
-- this column, keeping the Session row and all of its ClickHouse analytics.
-- Additive + nullable -> instant, no table rewrite, existing rows unaffected.
ALTER TABLE "Session" ADD COLUMN "replayPrunedAt" TIMESTAMP(3);

-- Backs the retention sweep's "find not-yet-pruned sessions older than the
-- cutoff": WHERE "workspaceId"=? AND "replayPrunedAt" IS NULL AND "startedAt"<?.
-- The nullable middle column lets the btree serve the IS NULL equality before
-- the startedAt range, so each hourly run visits only unpruned rows.
-- NOTE (prod at scale): on a very large Session table, create this CONCURRENTLY
-- instead to avoid a brief write lock:
--   CREATE INDEX CONCURRENTLY "Session_workspaceId_replayPrunedAt_startedAt_idx"
--     ON "Session"("workspaceId","replayPrunedAt","startedAt");
-- At the current row count a plain CREATE INDEX is effectively instant.
CREATE INDEX "Session_workspaceId_replayPrunedAt_startedAt_idx" ON "Session"("workspaceId", "replayPrunedAt", "startedAt");
