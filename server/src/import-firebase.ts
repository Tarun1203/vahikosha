// Imports a Firebase export (saved by the local app into
// D:\ChittamSuite\backups\firebase) into PostgreSQL, then checks it.
//   node src/import-firebase.ts [file]        (default: the newest export)
//   node src/import-firebase.ts [file] --dry  (report only, save nothing)
// One transaction: everything or nothing. Safe to run again: unchanged records
// are skipped and history entries are matched by their Firebase id.
// Tally copies (balances, tallyVouchers, tallyStock, tallyBills) stay in the
// backup file only: the accounting tables are filled from Tally itself.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { pool, tx } from "./db.ts";

const RECORDS = ["customers", "products", "transports", "orders", "services", "receipts", "messages", "settings"] as const;
const FROM_TALLY = ["balances", "tallyVouchers", "tallyStock", "tallyBills"];
type Doc = { id: string; [k: string]: unknown };

const cfg = loadConfig();
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const dir = join(cfg.storage, "..", "backups", "firebase");
const file = args.find((a) => !a.startsWith("--")) ||
  readdirSync(dir).filter((f) => f.startsWith("firebase-export-") && f.endsWith(".json")).map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
if (!file) { console.error("No export found in " + dir); process.exit(1); }

const snap = JSON.parse(readFileSync(file, "utf8")) as { exportedAt?: string; by?: string; collections: Record<string, Doc[]> };
console.log("Export: " + file + "\n  taken " + (snap.exportedAt || "?") + " by " + (snap.by || "?"));

// Firebase timestamps arrive as { __ts: "ISO" }: keep them as ISO text
const plain = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(plain)
  : v && typeof v === "object" ? ("__ts" in (v as object) && Object.keys(v as object).length === 1 ? (v as { __ts: string }).__ts
    : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)])))
  : v;
const when = (d: Record<string, unknown>, ...keys: string[]) => { for (const k of keys) if (typeof d[k] === "string" && !isNaN(Date.parse(d[k] as string))) return d[k] as string; return null; };
const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

const p = pool(cfg);
const report: string[] = [];
let problems = 0;
try {
  const counts = await tx(p, async (c) => {
    const out: Record<string, { inExport: number; added: number; changed: number; same: number }> = {};
    for (const coll of RECORDS) {
      const docs = snap.collections[coll] || [];
      const r = { inExport: docs.length, added: 0, changed: 0, same: 0 };
      for (const raw of docs) {
        const { id, ...rest } = raw;
        const data = plain(rest) as Record<string, unknown>;
        const created = when(data, "createdAt", "at", "updatedAt") || snap.exportedAt || new Date().toISOString();
        const updated = when(data, "updatedAt", "at", "createdAt") || created;
        const by = String(data.updatedBy || data.by || data.createdBy || "");
        const ex = await c.query(`SELECT data FROM ${coll} WHERE id = $1`, [id]);
        if (!ex.rowCount) {
          await c.query(`INSERT INTO ${coll} (id, data, created_at, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)`, [id, data, created, updated, by]);
          r.added++;
        } else if (JSON.stringify(ex.rows[0].data) !== JSON.stringify(data)) {
          // compare as stored by PostgreSQL (key order normalised)
          const same = (await c.query(`SELECT data = $2::jsonb AS eq FROM ${coll} WHERE id = $1`, [id, data])).rows[0].eq;
          if (same) r.same++;
          else { await c.query(`UPDATE ${coll} SET data = $2, updated_by = $3 WHERE id = $1`, [id, data, by]); r.changed++; }
        } else r.same++;
      }
      out[coll] = r;
    }
    // history: append what isn't there yet (matched by the Firebase id)
    const acts = snap.collections.activity || [];
    let added = 0, same = 0;
    for (const raw of acts) {
      const a = plain(raw) as Record<string, unknown>;
      const seen = await c.query("SELECT 1 FROM activity WHERE details->>'firestoreId' = $1 LIMIT 1", [a.id]);
      if (seen.rowCount) { same++; continue; }
      await c.query(`INSERT INTO activity (at, by_user, collection, record_id, action, name, details, before, after)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [when(a, "at") || snap.exportedAt || new Date().toISOString(), String(a.by || ""), String(a.collection || "app"), a.docId ? String(a.docId) : null,
         String(a.action || "?"), String(a.name || ""), { ...((a.details as object) || {}), firestoreId: a.id, importedFrom: "firebase" },
         a.before ?? null, a.after ?? null]);
      added++;
    }
    out.activity = { inExport: acts.length, added, changed: 0, same };
    if (!dry) await c.query("INSERT INTO activity (collection, action, name, details) VALUES ('app', 'firebase-import', $1, $2)", [file, { file, counts: out }]);
    if (dry) throw Object.assign(new Error("dry run"), { dry: true, out });
    return out;
  }).catch((e) => { if ((e as { dry?: boolean }).dry) return (e as unknown as { out: Record<string, { inExport: number; added: number; changed: number; same: number }> }).out; throw e; });

  console.log(dry ? "\nDRY RUN — nothing was saved\n" : "\nImported\n");
  console.log("  collection     in export   added  changed  unchanged");
  for (const [k, v] of Object.entries(counts)) console.log("  " + k.padEnd(14) + String(v.inExport).padStart(9) + String(v.added).padStart(8) + String(v.changed).padStart(9) + String(v.same).padStart(11));
  for (const k of FROM_TALLY) console.log("  " + k.padEnd(14) + String((snap.collections[k] || []).length).padStart(9) + "   (kept in the backup file; rebuilt from Tally)");
  const unknown = Object.keys(snap.collections).filter((k) => !(RECORDS as readonly string[]).includes(k) && k !== "activity" && !FROM_TALLY.includes(k));
  if (unknown.length) { problems++; report.push("Not imported (unknown collections): " + unknown.join(", ")); }

  if (!dry) {
    // ---- checks: every record is there, and the money adds up
    console.log("\nChecks");
    for (const coll of RECORDS) {
      const ids = (snap.collections[coll] || []).map((d) => d.id);
      const n = ids.length ? (await p.query(`SELECT count(*)::int AS n FROM ${coll} WHERE id = ANY($1)`, [ids])).rows[0].n : 0;
      if (n === ids.length) console.log("  ok    " + coll + ": all " + n + " records present");
      else { problems++; console.log("  FAIL  " + coll + ": " + n + " of " + ids.length + " present"); }
    }
    const exp = (snap.collections.receipts || []).filter((r) => !r.cancelled);
    const expTotals = { business: money(exp.reduce((t, r) => t + money(r.business), 0)), cash: money(exp.reduce((t, r) => t + money(r.cash), 0)) };
    const db = (await p.query(`SELECT COALESCE(sum((data->>'business')::numeric), 0) AS business, COALESCE(sum((data->>'cash')::numeric), 0) AS cash
      FROM receipts WHERE NOT cancelled AND id = ANY($1)`, [(snap.collections.receipts || []).map((r) => r.id)])).rows[0];
    const dbTotals = { business: money(db.business), cash: money(db.cash) };
    if (dbTotals.business === expTotals.business && dbTotals.cash === expTotals.cash)
      console.log("  ok    payments total: Chittam Enterprises Rs. " + expTotals.business.toLocaleString("en-IN") + ", Cash Rs. " + expTotals.cash.toLocaleString("en-IN") + " (same in both)");
    else { problems++; console.log("  FAIL  payments total: export " + JSON.stringify(expTotals) + " vs database " + JSON.stringify(dbTotals)); }
    const ordersOpen = (snap.collections.orders || []).filter((o) => o.status !== "Delivered" && o.status !== "Cancelled").length;
    const dbOpen = (await p.query("SELECT count(*)::int AS n FROM orders WHERE status NOT IN ('Delivered', 'Cancelled') OR status IS NULL")).rows[0].n;
    if (dbOpen >= ordersOpen) console.log("  ok    open orders: " + ordersOpen);
    else { problems++; console.log("  FAIL  open orders: export " + ordersOpen + " vs database " + dbOpen); }
    const hist = (await p.query("SELECT count(*)::int AS n FROM activity WHERE details->>'importedFrom' = 'firebase'")).rows[0].n;
    if (hist >= (snap.collections.activity || []).length) console.log("  ok    history: " + hist + " entries");
    else { problems++; console.log("  FAIL  history: " + hist + " of " + (snap.collections.activity || []).length); }
  }
} finally {
  await p.end();
}
for (const r of report) console.log("  !     " + r);
console.log(problems ? "\n" + problems + " problem(s) — see above" : dry ? "" : "\nAll data is in PostgreSQL and matches the export.");
process.exit(problems ? 1 : 0);
