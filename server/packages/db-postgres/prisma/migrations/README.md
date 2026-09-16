# Database migrations (Postgres)

Postgres uses **Prisma Migrate**. `db push` is retired for this database.
(MongoDB still uses `db push` — Prisma has no migrate workflow for Mongo.)

Run everything from the repo root.

## Dev — after changing `schema.prisma`

```bash
yarn prisma:migrate      # prisma migrate dev: creates a new migration + applies it locally
```

Commit the generated `prisma/migrations/<timestamp>_<name>/migration.sql`.

> Needs a **shadow database**. A local Postgres superuser creates one
> automatically; if yours can't, add `shadowDatabaseUrl = env("SHADOW_DATABASE_URL")`
> to the `datasource` block and point it at an empty scratch DB.

## Production / staging deploy

```bash
yarn prisma:deploy       # prisma migrate deploy: applies committed, pending migrations
```

No prompts, no `--accept-data-loss`, reproducible, reversible. **This is the only
command that touches a deployed database from now on.**

## First-time cutover on an existing DB (one-time, per environment)

`0_init` is a **baseline** of the schema as it stood on production *before*
migrations existed — all tables, enums and `pg_trgm`, but **not** the later
`publicKey` column, which lives in its own timestamped migration. Dev is already
baselined. For an existing prod/staging DB where these tables already exist:

```bash
# 1. (recommended) Confirm the DB is actually at the 0_init state — this should
#    print ONLY the publicKey ALTER and nothing else:
npx prisma migrate diff \
  --from-url "$DATABASE_URL_POSTGRES" \
  --to-schema-datamodel ./packages/db-postgres/prisma/schema.prisma --script

# 2. Tell Migrate the baseline is already applied (so deploy won't re-create tables):
npx prisma migrate resolve --applied 0_init \
  --schema=./packages/db-postgres/prisma/schema.prisma

# 3. Apply everything after the baseline (right now: just the publicKey column):
yarn prisma:deploy
```

If step 1 prints more than the `publicKey` ALTER, that environment has other
un-deployed changes — capture them with `prisma migrate dev --create-only` before
step 3. **No `db push` anywhere in this flow.**
