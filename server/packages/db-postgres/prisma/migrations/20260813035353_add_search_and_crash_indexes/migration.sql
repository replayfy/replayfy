-- Search + crashlytics indexes.
--
-- WHAT
--   · EndUser_distinctId_idx / EndUser_city_idx (GIN gin_trgm_ops) — index the two
--     Users-LIST search-OR branches (distinctId, city) that email/name already had
--     but these lacked, so the whole search OR is index-backed instead of forcing a
--     per-workspace seq-scan (a single un-indexable OR branch defeats the others).
--   · IssueOccurrence_workspaceId_occurredAt_idx (btree) — backs the Crashlytics
--     per-category sparklines: a bounded 60-day `GROUP BY floor(days_ago), errorClass`
--     that range-scans ONE workspace's recent occurrences instead of the whole table.
--
-- PROD DEPLOY NOTE (READ BEFORE `prisma migrate deploy`)
--   These are PLAIN (transactional) CREATE INDEX statements, because CREATE INDEX
--   CONCURRENTLY cannot run inside the transaction Prisma wraps each migration in.
--   Plain CREATE INDEX takes a lock that blocks WRITES to the table for the whole
--   build — fine on a fresh/small table, but on a large prod EndUser / IssueOccurrence
--   it stalls ingest. On a large prod DB, prefer to build them CONCURRENTLY out of
--   band first and then mark this migration applied without re-running it:
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS "EndUser_distinctId_idx" ON "EndUser" USING GIN ("distinctId" gin_trgm_ops);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS "EndUser_city_idx"       ON "EndUser" USING GIN ("city" gin_trgm_ops);
--     CREATE INDEX CONCURRENTLY IF NOT EXISTS "IssueOccurrence_workspaceId_occurredAt_idx" ON "IssueOccurrence" ("workspaceId", "occurredAt");
--     yarn prisma migrate resolve --applied 20260813035353_add_search_and_crash_indexes
--   The IF NOT EXISTS below makes the migration a no-op if you already built them.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX IF NOT EXISTS "EndUser_distinctId_idx" ON "EndUser" USING GIN ("distinctId" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "EndUser_city_idx" ON "EndUser" USING GIN ("city" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "IssueOccurrence_workspaceId_occurredAt_idx" ON "IssueOccurrence" ("workspaceId", "occurredAt");
