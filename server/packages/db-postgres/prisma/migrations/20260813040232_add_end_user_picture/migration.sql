-- EndUser.picture — avatar URL from identify() (`picture` / `avatar` trait, or
-- nested in customProps). A discrete, nullable column so the session→player
-- endUser summary select can carry it without joining the customProps blob.
--
-- Adding a NULLABLE column with no default is a metadata-only change in Postgres
-- (no table rewrite, no row locks held for the scan), so this is safe to run via
-- `prisma migrate deploy` even on a large EndUser table.
ALTER TABLE "EndUser" ADD COLUMN IF NOT EXISTS "picture" TEXT;
