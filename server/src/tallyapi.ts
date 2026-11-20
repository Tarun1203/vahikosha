// The Tally figures the app's pages use, built from the mirror in exactly the
// shapes the Windows app used to upload to Firebase (balances, tallyVouchers,
// tallyBills, tallyStock), so no page has to change.
import type pg from "pg";

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const r2 = (n: number) => Math.round(n * 100) / 100;

// customers' ledgers: everything under Sundry Debtors, plus parties under
// Sundry Creditors that are customers in the app (people you buy from and sell to)
const PARTIES = `
  WITH RECURSIVE tree AS (
    SELECT company_id, name, CASE WHEN name = 'Sundry Debtors' THEN 'D' ELSE 'C' END AS root
      FROM account_groups WHERE name IN ('Sundry Debtors', 'Sundry Creditors')
    UNION ALL
    SELECT g.company_id, g.name, t.root FROM account_groups g JOIN tree t ON g.company_id = t.company_id AND g.parent = t.name
  )
  SELECT l.company_id, l.name FROM ledgers l JOIN tree t ON t.company_id = l.company_id AND t.name = l.group_name
  WHERE t.root = 'D' OR l.customer_id IS NOT NULL`;

async function meta(db: pg.Pool) {
  const r = await db.query(`SELECT c.id, c.label, c.tally_company,
      (SELECT max(finished_at) FROM sync_runs s WHERE s.company_id = c.id AND s.kind = 'mirror' AND s.finished_at IS NOT NULL) AS synced
    FROM companies c`);
  return Object.fromEntries(r.rows.map((x) => [x.id, { label: x.label as string, tallyCompany: x.tally_company as string, syncedAt: x.synced ? new Date(x.synced).toISOString() : "" }]));
}

export async function balances(db: pg.Pool) {
  const m = await meta(db);
  const rows = (await db.query(`WITH p AS (${PARTIES})
    SELECT c.company_id, c.ledger, c.closing FROM ledger_closing c JOIN p ON p.company_id = c.company_id AND p.name = c.ledger
    WHERE current_date BETWEEN c.starts AND c.ends`)).rows;
  const out: Record<string, unknown> = {};
  for (const co of ["business", "cash"]) {
    const bal: Record<string, number> = {}, names: Record<string, string> = {};
    for (const r of rows.filter((x) => x.company_id === co)) { const k = norm(r.ledger); bal[k] = r2(Number(r.closing)); names[k] = r.ledger; }
    out[co] = { company: co, label: m[co]?.label, tallyCompany: m[co]?.tallyCompany, importedAt: m[co]?.syncedAt, importedBy: "tally-mirror", balances: bal, names };
  }
  // when Tally was last read (the app warns when it's old)
  // the latest run per company decides "ok"
  const last = (await db.query(`SELECT DISTINCT ON (company_id) company_id, finished_at, ok, error FROM sync_runs
    WHERE kind = 'mirror' AND finished_at IS NOT NULL ORDER BY company_id, id DESC`)).rows;
  const at = last.map((r) => new Date(r.finished_at).getTime());
  const bad = last.filter((r) => r.ok === false && r.error);
  out.status = { checkedAt: at.length ? new Date(Math.min(...at)).toISOString() : "", ok: bad.length === 0, error: bad.map((r) => r.company_id + ": " + r.error).join("; ") };
  return out;
}

export async function vouchers(db: pg.Pool) {
  const m = await meta(db);
  const rows = (await db.query(`WITH p AS (${PARTIES})
    SELECT v.company_id, v.vdate, v.vtype, v.number, e.ledger, e.amount, v.narration, v.tally_guid,
      (SELECT string_agg(DISTINCT o.ledger, ', ') FROM voucher_entries o WHERE o.voucher_id = v.id AND o.ledger <> e.ledger) AS via
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    JOIN p ON p.company_id = v.company_id AND p.name = e.ledger
    WHERE v.is_current AND v.status = 'posted'
    ORDER BY v.vdate DESC, v.number`)).rows;
  const out: Record<string, unknown> = {};
  for (const co of ["business", "cash"]) {
    const list = rows.filter((x) => x.company_id === co).map((r) => ({
      d: r.vdate, t: r.vtype, n: r.number, p: r.ledger, a: r2(Math.abs(Number(r.amount))), dr: Number(r.amount) > 0,
      nar: String(r.narration || "").slice(0, 80), via: String(r.via || "").slice(0, 60), id: r.tally_guid || "",
    }));
    const span = (await db.query("SELECT min(starts) AS f FROM financial_years WHERE company_id = $1", [co])).rows[0];
    out[co] = { company: co, label: m[co]?.label, tallyCompany: m[co]?.tallyCompany, from: span?.f || "", to: new Date().toISOString().slice(0, 10),
      syncedAt: m[co]?.syncedAt, count: list.length, vouchers: list };
  }
  return out;
}

export async function bills(db: pg.Pool) {
  const m = await meta(db);
  const rows = (await db.query(`WITH p AS (${PARTIES})
    SELECT b.company_id, b.ledger, b.bill, b.bill_date, b.due_date, b.pending,
      GREATEST(0, current_date - b.due_date) AS od
    FROM bills_outstanding b JOIN p ON p.company_id = b.company_id AND p.name = b.ledger
    WHERE b.pending > 0 ORDER BY b.bill_date`)).rows;
  const out: Record<string, unknown> = {};
  for (const co of ["business", "cash"])
    out[co] = { company: co, label: m[co]?.label, tallyCompany: m[co]?.tallyCompany, syncedAt: m[co]?.syncedAt, asOn: new Date().toISOString().slice(0, 10),
      bills: rows.filter((x) => x.company_id === co).map((r) => ({ p: r.ledger, n: r.bill, d: r.bill_date || "", due: r.due_date || "", a: r2(Number(r.pending)), od: r.od ? Number(r.od) : 0 })) };
  return out;
}

export async function stock(db: pg.Pool) {
  const m = await meta(db);
  // Tally's own closing quantity when known; otherwise worked out from the vouchers
  const rows = (await db.query(`
    SELECT s.company_id, s.name, s.unit, COALESCE(s.closing_qty,
      COALESCE((SELECT sum(o.qty) FROM stock_openings o WHERE o.company_id = s.company_id AND o.item = s.name
                 AND o.fy_id = (SELECT id FROM financial_years f WHERE f.company_id = s.company_id ORDER BY starts LIMIT 1)), 0)
      + COALESCE((SELECT sum(i.qty) FROM inventory_entries i JOIN vouchers v ON v.id = i.voucher_id
                 WHERE v.company_id = s.company_id AND i.item = s.name AND v.is_current AND v.status = 'posted'), 0)) AS qty
    FROM stock_items s`)).rows;
  const out: Record<string, unknown> = {};
  for (const co of ["business", "cash"]) {
    const items: Record<string, { n: string; q: number; u: string }> = {};
    for (const r of rows.filter((x) => x.company_id === co)) items[norm(r.name)] = { n: r.name, q: r2(Number(r.qty)), u: r.unit || "" };
    out[co] = { company: co, label: m[co]?.label, tallyCompany: m[co]?.tallyCompany, syncedAt: m[co]?.syncedAt, items };
  }
  return out;
}
