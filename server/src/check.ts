// Proves the database rules work. Everything runs inside one transaction that
// is always rolled back, so no test data is ever left behind.
import { loadConfig } from "./config.ts";
import { pool } from "./db.ts";

const p = pool(loadConfig());
const c = await p.connect();
let failed = 0;
const ok = (name: string) => console.log("  ok    " + name);
const bad = (name: string, why: string) => { failed++; console.log("  FAIL  " + name + " — " + why); };

// expect a statement to be refused (checked inside a savepoint)
async function refused(name: string, sql: string, params: unknown[] = []) {
  await c.query("SAVEPOINT s");
  try { await c.query(sql, params); await c.query("SET CONSTRAINTS ALL IMMEDIATE"); bad(name, "it was allowed"); }
  catch { ok(name); }
  await c.query("ROLLBACK TO SAVEPOINT s");
}

try {
  const tables = (await c.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0].n;
  const migs = (await c.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
  console.log("Database: " + tables + " tables · migrations: " + migs.join(", "));

  await c.query("BEGIN");
  await c.query("INSERT INTO customers (id, data) VALUES ('t1', '{\"name\":\"Test Customer\",\"mobile\":\"9000000000\"}')");
  const r = (await c.query("SELECT name, mobile, version FROM customers WHERE id = 't1'")).rows[0];
  r?.name === "Test Customer" && r?.mobile === "9000000000" ? ok("record saved; name and mobile read from its data") : bad("record saved", JSON.stringify(r));
  await c.query("UPDATE customers SET data = data || '{\"name\":\"Test 2\"}' WHERE id = 't1'");
  const v = (await c.query("SELECT version FROM customers WHERE id = 't1'")).rows[0].version;
  v === 2 ? ok("edit raises the version number") : bad("edit raises the version number", "version " + v);
  await refused("deleting a customer is refused", "DELETE FROM customers WHERE id = 't1'");
  await refused("emptying a table is refused", "TRUNCATE customers");
  await c.query("INSERT INTO activity (collection, record_id, action) VALUES ('customers', 't1', 'test')");
  await refused("history can't be edited", "UPDATE activity SET action = 'x' WHERE record_id = 't1'");

  // accounting
  await c.query("INSERT INTO financial_years (company_id, starts, ends) VALUES ('business', '2026-04-01', '2027-03-31') ON CONFLICT DO NOTHING");
  await c.query("INSERT INTO ledgers (company_id, name, group_name) VALUES ('business', 'Check Cash', 'Cash-in-Hand'), ('business', 'Check Customer', 'Sundry Debtors')");
  const bal = await c.query(`INSERT INTO vouchers (company_id, vtype, base_type, number, vdate, party, owner, entry_key)
    VALUES ('business', 'App Receipt', 'Receipt', 'T1', '2026-11-20', 'Test Customer', 'app', 'test-key-1') RETURNING id`);
  const vid = bal.rows[0].id;
  await c.query("INSERT INTO voucher_entries (voucher_id, line, ledger, amount, is_party) VALUES ($1, 1, 'Check Cash', 1000, false), ($1, 2, 'Check Customer', -1000, true)", [vid]);
  await c.query("SAVEPOINT s");
  try { await c.query("SET CONSTRAINTS ALL IMMEDIATE"); ok("balanced voucher is accepted"); } catch (e) { bad("balanced voucher is accepted", (e as Error).message); }
  await c.query("ROLLBACK TO SAVEPOINT s");

  const unb = await c.query(`INSERT INTO vouchers (company_id, vtype, base_type, number, vdate, party, owner, entry_key)
    VALUES ('business', 'App Receipt', 'Receipt', 'T2', '2026-11-20', 'Test Customer', 'app', 'test-key-2') RETURNING id`);
  await refused("voucher that doesn't balance is refused",
    "INSERT INTO voucher_entries (voucher_id, line, ledger, amount) VALUES ($1, 1, 'Check Cash', 1000), ($1, 2, 'Check Customer', -900)", [unb.rows[0].id]);
  await refused("same entry key twice is refused (no duplicates)",
    "INSERT INTO vouchers (company_id, vtype, number, vdate, owner, entry_key) VALUES ('business', 'App Receipt', 'T3', '2026-11-20', 'app', 'test-key-1')");
  await refused("posted voucher can't be edited", "UPDATE vouchers SET party = 'Someone Else' WHERE id = $1", [vid]);
  await refused("posted voucher's lines can't be edited", "UPDATE voucher_entries SET amount = 2000 WHERE voucher_id = $1 AND line = 1", [vid]);
  await c.query("SAVEPOINT s");
  try { await c.query("UPDATE vouchers SET status = 'cancelled' WHERE id = $1", [vid]); ok("posted voucher can be cancelled"); }
  catch (e) { bad("posted voucher can be cancelled", (e as Error).message); }
  await c.query("ROLLBACK TO SAVEPOINT s");
  await refused("deleting a voucher is refused", "DELETE FROM vouchers WHERE id = $1", [vid]);
  await c.query("INSERT INTO period_locks (company_id, month, reason) VALUES ('business', '2026-10-01', 'GST filed')");
  await refused("no new app voucher in a locked month",
    "INSERT INTO vouchers (company_id, vtype, number, vdate, owner, entry_key) VALUES ('business', 'App Receipt', 'T4', '2026-10-15', 'app', 'test-key-4')");
  const tb = (await c.query("SELECT t.ledger, t.debit, t.credit FROM trial_balance t JOIN financial_years f ON f.id = t.fy_id WHERE t.company_id = 'business' AND t.ledger LIKE 'Check %' AND f.starts = '2026-04-01' ORDER BY t.ledger")).rows;
  tb.length === 2 && tb[0].ledger === "Check Cash" && tb[0].debit === 1000 && tb[1].credit === 1000 ? ok("trial balance adds up") : bad("trial balance adds up", JSON.stringify(tb));
} catch (e) {
  bad("check stopped", (e as Error).message);
} finally {
  await c.query("ROLLBACK").catch(() => {});
  c.release();
  await p.end();
}
console.log(failed ? failed + " check(s) failed" : "All checks passed (nothing was saved).");
process.exit(failed ? 1 : 0);
