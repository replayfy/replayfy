# `@replay/ingest-api`

Minimal NestJS-shaped replay ingest app.

## Responsibility

- accept replay batch envelopes from SDKs
- persist raw replay chunks to object storage
- persist segment/session manifests to PostgreSQL
- enqueue projection work for BullMQ
- project console/network/error rows into ClickHouse

## Expected request contract

`POST /v1/replay/batch`

Headers:

- `x-replay-api-key`
- `content-type: application/json`

Body:

- `ReplayBatchEnvelope` from `@replay/replay-schema`

## Intended NestJS mapping

- `ReplayIngestController`
  - Nest `@Controller("v1/replay")`
  - `@Post("batch")`

- `ReplayIngestService`
  - API key auth
  - payload validation
  - raw chunk storage
  - Postgres manifest write
  - BullMQ enqueue

- Queue worker
  - reads stored replay chunk
  - extracts console/network/error events
  - inserts projections into ClickHouse

## Data flow

1. web SDK posts replay batch
2. ingest API validates and writes raw envelope to object storage
3. ingest API stores manifest row in PostgreSQL
4. ingest API enqueues BullMQ projection job
5. worker writes searchable rows into ClickHouse
6. dashboard player reads raw replay from object storage and timeline tabs from ClickHouse
