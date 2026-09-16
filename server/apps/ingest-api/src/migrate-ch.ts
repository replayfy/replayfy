/**
 * Apply the ClickHouse schema (CREATE DATABASE replay + tables) at DEPLOY time,
 * the same way `prisma:deploy` applies the Postgres migrations. Idempotent:
 * ensureClickHouseSchema() is entirely `IF NOT EXISTS`, so re-running is a no-op.
 *
 * Why this exists: the schema was previously created LAZILY, on the first replay
 * ingest (replay-persistence.service). On a freshly-deployed workspace that has
 * not recorded a session yet, every dashboard READ (metrics, segments,
 * activity-series, …) hit `replay.*` before any write had created it and 500'd
 * with "Database replay does not exist". Applying the schema on deploy closes
 * that read-before-first-write gap for good.
 *
 *   npm run build && npm run ch:migrate
 */
import "reflect-metadata";
import { config as loadEnv } from "dotenv";
import {
  ensureClickHouseSchema,
  disconnectClickHouse,
} from "@replay/db-clickhouse";

loadEnv({ override: true });
loadEnv({ path: ".env.local", override: true });

async function main(): Promise<void> {
  // The DDL connection must target a database that already EXISTS — `replay`
  // itself may not yet (that is exactly what we are about to create), so pin the
  // connection's default db to the always-present `default`. This sets only the
  // CONNECTION default; ensureClickHouseSchema() always creates the fixed
  // `replay` database and its fully-qualified tables regardless of this value.
  process.env.CLICKHOUSE_DATABASE = "default";
  await ensureClickHouseSchema();
  await disconnectClickHouse();
  process.stdout.write(
    "ClickHouse schema applied (replay database + tables).\n",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    process.stderr.write(
      `ClickHouse schema migration failed: ${(e as Error).message}\n`,
    );
    process.exit(1);
  });
