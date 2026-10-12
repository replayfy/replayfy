/**
 * String repair helpers (lone UTF-16 surrogates, NUL). The implementation lives
 * in @replay/db-clickhouse, which needs it for every ClickHouse insert and can't
 * import from the app; re-exported here for the app's own call sites.
 */
export {
  wellFormed,
  truncateWellFormed,
  makeWellFormedInPlace,
} from "@replay/db-clickhouse";
