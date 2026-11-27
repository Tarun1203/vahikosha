import pg from "pg";
import type { Config } from "./config.ts";

// numeric (money) comes back as a JS number, dates as "YYYY-MM-DD" text
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

// Chittam Enterprises: the first business (migration 010). The Tally mirror,
// the Firebase copy and the command-line tools work for it.
export const CHITTAM_BUSINESS = "00000000-0000-4000-8000-000000000001";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A pool of database connections.
//   pool(cfg, id)   every connection works for business `id` only
//   pool(cfg, null) connections work for no business: they see no business
//                   data until a transaction says which one (inBusiness)
export function pool(cfg: Config, business: string | null, name = "vahikosha-server") {
  if (business !== null && !UUID.test(business)) throw new Error("Not a business id: " + business);
  return new pg.Pool({
    ...cfg.db, max: 10, application_name: name,
    ...(business ? { options: "-c vahikosha.business_id=" + business } : {}),
  });
}

export type Db = pg.Pool | pg.PoolClient;

// run fn inside one transaction; everything or nothing
export async function tx<T>(p: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await p.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// run fn in one transaction that works for one business: the database shows
// it that business's rows only, and new rows are saved to that business
export function inBusiness<T>(p: pg.Pool, business: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!UUID.test(business)) throw new Error("Not a business id: " + business);
  return tx(p, async (c) => {
    await c.query("SELECT set_config('vahikosha.business_id', $1, true)", [business]);
    return fn(c);
  });
}
