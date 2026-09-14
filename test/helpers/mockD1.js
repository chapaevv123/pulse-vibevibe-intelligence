// Minimal read-only D1 stub: an empty database. Every prepared statement
// resolves to "no rows" so route/handler code paths can be exercised without
// a real Cloudflare D1 binding (used only for HTTP-shape and read-only-route
// tests, not for sync/write-path testing).
export function makeEmptyD1() {
  const stmt = {
    bind() {
      return stmt;
    },
    async first() {
      return null;
    },
    async all() {
      return { results: [] };
    },
    async run() {
      return { meta: { changes: 0 } };
    },
  };
  return {
    prepare() {
      return stmt;
    },
  };
}
