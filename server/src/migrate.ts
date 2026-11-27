// Applies the SQL files in server/migrations in name order, each once, each in
// its own transaction, and records them in schema_migrations.
import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { pool, tx } from "./db.ts";

const dir = join(import.meta.dirname, "..", "migrations");

// upTo: stop after this file (the tests use it to fill an older database first)
export async function migrate(log = console.log, upTo = "") {
  const p = pool(loadConfig(), null, "vahikosha-migrate");
  try {
    await p.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await p.query("SELECT name, sha256 FROM schema_migrations")).rows.map((r) => [r.name as string, r.sha256 as string]));
    const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f) && (!upTo || f <= upTo)).sort();
    let applied = 0;
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      // line endings don't count (git may check files out with CRLF or LF)
      const lf = sql.replace(/\r\n/g, "\n");
      const sha = createHash("sha256").update(lf).digest("hex");
      const shaCrlf = createHash("sha256").update(lf.replace(/\n/g, "\r\n")).digest("hex");
      if (done.has(f)) {
        if (done.get(f) !== sha && done.get(f) !== shaCrlf) throw new Error(f + " was changed after it was applied. Add a new migration instead.");
        continue;
      }
      await tx(p, async (c) => {
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [f, sha]);
      });
      log("applied " + f);
      applied++;
    }
    log(applied ? applied + " migration(s) applied" : "database is up to date");
  } finally {
    await p.end();
  }
}

if (process.argv[1]?.endsWith("migrate.ts")) migrate().catch((e) => { console.error(e.message); process.exit(1); });
