import pg from "pg";
import type { Config } from "./config.ts";

// numeric (money) comes back as a JS number, dates as "YYYY-MM-DD" text
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);

export function pool(cfg: Config) {
  return new pg.Pool({ ...cfg.db, max: 10, application_name: "chittam-server" });
}

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
