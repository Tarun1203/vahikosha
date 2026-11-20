// Stage A: mirror Tally into the accounting tables (read-only on Tally's side).
//   node src/mirror-tally.ts            both companies
//   node src/mirror-tally.ts business   one company
// For each company: groups, ledgers (+ opening balances), voucher types, stock
// masters, and every voucher since the books began, with ledger lines,
// bill-wise and bank details and item lines. Then every balance-sheet ledger's
// closing balance is compared with Tally's own figure.
// Safe to repeat: unchanged vouchers (same Tally AlterID) are skipped; a changed
// voucher is added as a new version and the old one marked superseded; a voucher
// that no longer exists in Tally is marked cancelled. Nothing is deleted.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { loadConfig } from "./config.ts";
import { pool } from "./db.ts";
import { createHash } from "node:crypto";
import { collection, date, list, nameOf, num, post, txt, yes } from "./tally.ts";

type Co = "business" | "cash";

// which Tally company is which: from the Windows app's settings (it follows the year switch)
function tallyCompanies(): Record<Co, string> {
  const f = join(process.env.APPDATA || "", "ChittamEnterprises", "settings.json");
  const s = JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")) as { BusinessCompany?: string; CashCompany?: string };
  return { business: s.BusinessCompany || "", cash: s.CashCompany || "" };
}

const NON_ACCOUNTING = new Set(["Sales Order", "Purchase Order", "Memorandum", "Reversing Journal", "Job Work In Order", "Job Work Out Order", "Attendance", "Payroll"]);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const r2 = (n: number) => Math.round(n * 100) / 100;
const iso = (d: Date) => d.toISOString().slice(0, 10);

const VFETCH = "Date, VoucherTypeName, VoucherNumber, PartyLedgerName, Narration, Reference, ReferenceDate, GUID, MasterID, AlterID, IsCancelled, IsOptional, " +
  "BasicBuyerName, PartyGSTIN, PlaceOfSupply, BasicShipDocumentNo, BasicShippedBy, BasicFinalDestination, BasicDueDateOfPymt, " +
  "AllLedgerEntries.LedgerName, AllLedgerEntries.Amount, AllLedgerEntries.IsPartyLedger, " +
  "AllLedgerEntries.BillAllocations.Name, AllLedgerEntries.BillAllocations.BillType, AllLedgerEntries.BillAllocations.Amount, AllLedgerEntries.BillAllocations.BillCreditPeriod, " +
  "AllLedgerEntries.BankAllocations.TransactionType, AllLedgerEntries.BankAllocations.InstrumentNumber, AllLedgerEntries.BankAllocations.InstrumentDate, AllLedgerEntries.BankAllocations.BankName, " +
  "AllInventoryEntries.StockItemName, AllInventoryEntries.ActualQty, AllInventoryEntries.BilledQty, AllInventoryEntries.Rate, AllInventoryEntries.Amount, AllInventoryEntries.Discount, " +
  "AllInventoryEntries.IsDeemedPositive, AllInventoryEntries.GSTHSNName, AllInventoryEntries.BatchAllocations.GodownName, AllInventoryEntries.BatchAllocations.BatchName";

async function mirror(db: pg.Pool, co: Co, company: string, log: (s: string) => void = console.log) {
  const say = (s: string) => log("[" + company + "] " + s);
  const run = (await db.query("INSERT INTO sync_runs (company_id, kind) VALUES ($1, 'mirror') RETURNING id", [co])).rows[0].id;
  const c = await db.connect();
  try {
    // ---- company and its financial years (one per April since the books began)
    const info = (await collection(company, "Company", "Name, StartingFrom, BooksFrom", { filter: "$Name = \"" + company.replace(/"/g, "") + "\"" }))[0];
    if (!info) throw new Error("Company not open in Tally: " + company);
    const today = iso(new Date());
    // Only the current financial year is mirrored. Ledgers and stock are read the
    // normal way (Tally's own period, opening = 1 April); asking Tally to recompute
    // ledgers or bills over a custom range of years made it freeze.
    const fyStart = (Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1)) + "-04-01";
    const booksFrom = [date(info.BOOKSFROM) || date(info.STARTINGFROM) || fyStart, fyStart].sort()[1];
    await c.query("BEGIN");
    await c.query("UPDATE companies SET tally_company = $2 WHERE id = $1", [co, company]);
    const years: { id: number; starts: string; ends: string }[] = [];
    for (let y = Number(booksFrom.slice(0, 4)) - (Number(booksFrom.slice(5, 7)) < 4 ? 1 : 0); ; y++) {
      const starts = y + "-04-01", ends = (y + 1) + "-03-31";
      if (starts > today) break;
      const r = await c.query(`INSERT INTO financial_years (company_id, starts, ends, tally_company) VALUES ($1, $2, $3, $4)
        ON CONFLICT (company_id, starts) DO UPDATE SET tally_company = EXCLUDED.tally_company RETURNING id`, [co, starts, ends, company]);
      years.push({ id: r.rows[0].id, starts, ends });
    }
    const firstFy = years[0];

    // ---- groups (nature from Tally's flags)
    const groups = await collection(company, "Group", "Name, Parent, IsRevenue, IsDeemedPositive, GUID");
    for (const g of groups) {
      const nature = yes(g.ISREVENUE) ? (yes(g.ISDEEMEDPOSITIVE) ? "expense" : "income") : (yes(g.ISDEEMEDPOSITIVE) ? "asset" : "liability");
      await c.query(`INSERT INTO account_groups (company_id, name, parent, nature, tally_guid) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (company_id, name) DO UPDATE SET parent = EXCLUDED.parent, nature = EXCLUDED.nature, tally_guid = EXCLUDED.tally_guid, updated_at = now()
        WHERE (account_groups.parent, account_groups.nature, account_groups.tally_guid) IS DISTINCT FROM (EXCLUDED.parent, EXCLUDED.nature, EXCLUDED.tally_guid)`,
        [co, nameOf(g), txt(g.PARENT) === "Primary" ? "" : txt(g.PARENT), nature, txt(g.GUID)]);
    }

    // ---- ledgers and their opening balance at the start of the books (> 0 = Dr)
    const customers = new Map((await c.query("SELECT id, name FROM customers")).rows.map((r) => [norm(r.name || ""), r.id as string]));
    const ledgers = await collection(company, "Ledger", "Name, Parent, OpeningBalance, ClosingBalance, IsBillWiseOn, LedgerMobile, LedStateName, PartyGSTIN, PinCode, GUID, Address, BillCreditPeriod, " +
      "BillAllocations.Name, BillAllocations.BillDate, BillAllocations.OpeningBalance, BillAllocations.BillCreditPeriod");
    const tallyClosing = new Map<string, number>();
    for (const l of ledgers) {
      const name = nameOf(l);
      const addr = list(l["ADDRESS.LIST"]).flatMap((a) => list((a as Record<string, unknown>).ADDRESS).map(txt)).filter(Boolean);
      const r = await c.query(`INSERT INTO ledgers (company_id, name, group_name, gstin, state, pincode, address, mobile, credit_days, billwise, customer_id, tally_guid)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (company_id, name) DO UPDATE SET group_name = EXCLUDED.group_name, gstin = EXCLUDED.gstin, state = EXCLUDED.state, pincode = EXCLUDED.pincode,
          address = EXCLUDED.address, mobile = EXCLUDED.mobile, credit_days = EXCLUDED.credit_days, billwise = EXCLUDED.billwise,
          customer_id = COALESCE(EXCLUDED.customer_id, ledgers.customer_id), tally_guid = EXCLUDED.tally_guid, updated_at = now()
        RETURNING id`,
        [co, name, txt(l.PARENT), txt(l.PARTYGSTIN), txt(l.LEDSTATENAME), txt(l.PINCODE), addr, txt(l.LEDGERMOBILE),
         num(l.BILLCREDITPERIOD) || null, yes(l.ISBILLWISEON), customers.get(norm(name)) ?? null, txt(l.GUID)]);
      await c.query(`INSERT INTO ledger_openings (ledger_id, fy_id, amount) VALUES ($1, $2, $3)
        ON CONFLICT (ledger_id, fy_id) DO UPDATE SET amount = EXCLUDED.amount WHERE ledger_openings.amount <> EXCLUDED.amount`,
        [r.rows[0].id, firstFy.id, r2(-num(l.OPENINGBALANCE))]);
      await c.query("UPDATE ledger_openings SET amount = 0 WHERE ledger_id = $1 AND fy_id <> $2 AND amount <> 0", [r.rows[0].id, firstFy.id]);
      tallyClosing.set(name, r2(-num(l.CLOSINGBALANCE)));
      // bills carried in from before the books began
      for (const ob of list(l["BILLALLOCATIONS.LIST"])) {
        if (!txt(ob.NAME)) continue;
        const billDate = date(ob.BILLDATE);
        // credit period comes as "30 Days" or as a due date like "31-Mar-24"
        const cp = txt(ob.BILLCREDITPERIOD), cpDays = cp.match(/^(\d+)\s*Days?$/i);
        const cpDate = Date.parse(cp.replace(/-(\d\d)$/, "-20$1"));
        const due = cpDays && billDate ? iso(new Date(Date.parse(billDate) + Number(cpDays[1]) * 86400e3)) : !isNaN(cpDate) ? iso(new Date(cpDate + 12 * 3600e3)) : null;
        await c.query(`INSERT INTO opening_bills (company_id, ledger, name, bill_date, due_date, amount) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (company_id, ledger, name) DO UPDATE SET bill_date = EXCLUDED.bill_date, due_date = EXCLUDED.due_date, amount = EXCLUDED.amount
          WHERE (opening_bills.bill_date, opening_bills.due_date, opening_bills.amount) IS DISTINCT FROM (EXCLUDED.bill_date, EXCLUDED.due_date, EXCLUDED.amount)`,
          [co, name, txt(ob.NAME), billDate, due, r2(-num(ob.OPENINGBALANCE))]);
      }
    }

    // ---- voucher types (base type through the parent chain) and stock masters
    const vtypes = await collection(company, "VoucherType", "Name, Parent, NumberingMethod");
    const parentOf = new Map(vtypes.map((v) => [nameOf(v), txt(v.PARENT)]));
    const baseOf = (t: string) => { let x = t; for (let i = 0; i < 10; i++) { const p = parentOf.get(x); if (!p || p === x) return x; x = p; } return x; };
    for (const v of vtypes)
      await c.query(`INSERT INTO voucher_types (company_id, name, base_type, numbering) VALUES ($1, $2, $3, $4)
        ON CONFLICT (company_id, name) DO UPDATE SET base_type = EXCLUDED.base_type, numbering = EXCLUDED.numbering`, [co, nameOf(v), baseOf(nameOf(v)), txt(v.NUMBERINGMETHOD)]);
    for (const g of await collection(company, "StockGroup", "Name, Parent"))
      await c.query("INSERT INTO stock_groups (company_id, name, parent) VALUES ($1, $2, $3) ON CONFLICT (company_id, name) DO UPDATE SET parent = EXCLUDED.parent", [co, nameOf(g), txt(g.PARENT) === "Primary" ? "" : txt(g.PARENT)]);
    for (const u of await collection(company, "Unit", "Name"))
      await c.query("INSERT INTO units (company_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING", [co, nameOf(u)]);
    for (const g of await collection(company, "Godown", "Name, Parent"))
      await c.query("INSERT INTO godowns (company_id, name, parent) VALUES ($1, $2, $3) ON CONFLICT (company_id, name) DO UPDATE SET parent = EXCLUDED.parent", [co, nameOf(g), txt(g.PARENT) === "Primary" ? "" : txt(g.PARENT)]);
    const products = new Map((await c.query("SELECT id, name FROM products")).rows.map((r) => [norm(r.name || ""), r.id as string]));
    const items = await collection(company, "StockItem", "Name, Parent, BaseUnits, GUID, OpeningBalance, OpeningValue, ClosingBalance, ClosingValue");
    for (const s of items)
      await c.query(`INSERT INTO stock_items (company_id, name, group_name, unit, product_id, tally_guid) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (company_id, name) DO UPDATE SET group_name = EXCLUDED.group_name, unit = EXCLUDED.unit, product_id = COALESCE(EXCLUDED.product_id, stock_items.product_id), tally_guid = EXCLUDED.tally_guid, updated_at = now()`,
        [co, nameOf(s), txt(s.PARENT), txt(s.BASEUNITS), products.get(norm(nameOf(s))) ?? null, txt(s.GUID)]);
    // Tally's own closing stock (its delivery-note / tracking rules decide it)
    for (const s of items)
      await c.query("UPDATE stock_items SET closing_qty = $3, closing_value = $4, closing_at = now() WHERE company_id = $1 AND name = $2",
        [co, nameOf(s), num(s.CLOSINGBALANCE), r2(-num(s.CLOSINGVALUE))]);
    // opening stock at the start of the books (Tally: negative value = Dr)
    for (const s of items)
      await c.query(`INSERT INTO stock_openings (company_id, fy_id, item, qty, value) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (company_id, fy_id, item) DO UPDATE SET qty = EXCLUDED.qty, value = EXCLUDED.value
        WHERE (stock_openings.qty, stock_openings.value) IS DISTINCT FROM (EXCLUDED.qty, EXCLUDED.value)`,
        [co, firstFy.id, nameOf(s), num(s.OPENINGBALANCE), r2(-num(s.OPENINGVALUE))]);
    await c.query("UPDATE stock_openings SET qty = 0, value = 0 WHERE company_id = $1 AND fy_id <> $2 AND (qty <> 0 OR value <> 0)", [co, firstFy.id]);
    await c.query("COMMIT");
    say(groups.length + " groups, " + ledgers.length + " ledgers, " + vtypes.length + " voucher types, " + items.length + " stock items");

    // ---- vouchers since the books began
    // one month per request: asking Tally for years at once can make it hang
    const vouchers: Record<string, unknown>[] = [];
    for (let m = new Date(booksFrom + "T00:00:00Z"); iso(m) <= today; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
      const from = iso(m), end = iso(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)));
      vouchers.push(...(await collection(company, "Voucher", VFETCH, { from, to: end < today ? end : today })));
      await new Promise((r) => setTimeout(r, 300));   // a breather for Tally between months
    }
    const existing = new Map((await c.query("SELECT id, tally_guid, details->>'alterId' AS alter_id FROM vouchers WHERE company_id = $1 AND owner = 'tally' AND is_current", [co]))
      .rows.map((r) => [r.tally_guid as string, { id: r.id as string, alterId: r.alter_id as string }]));
    const seen = new Set<string>();
    let added = 0, changed = 0, same = 0, skipped = 0;
    const failures: string[] = [];
    await c.query("BEGIN");
    for (const v of vouchers) {
      const guid = txt(v.GUID);
      if (!guid || yes(v.ISOPTIONAL)) { skipped++; continue; }
      seen.add(guid);
      const alterId = txt(v.ALTERID);
      const prev = existing.get(guid);
      if (prev && prev.alterId === alterId) { same++; continue; }
      const vtype = txt(v.VOUCHERTYPENAME), base = baseOf(vtype);
      const vdate = date(v.DATE);
      if (!vdate) { skipped++; continue; }
      const status = yes(v.ISCANCELLED) ? "cancelled" : NON_ACCOUNTING.has(base) ? "draft" : "posted";
      const fy = years.find((y) => vdate >= y.starts && vdate <= y.ends)?.id ?? null;
      const id = randomUUID();
      await c.query("SAVEPOINT v");
      try {
        if (prev) await c.query("UPDATE vouchers SET is_current = false, superseded_by = $2 WHERE id = $1", [prev.id, id]);
        await c.query(`INSERT INTO vouchers (id, company_id, fy_id, vtype, base_type, number, vdate, party, reference, reference_date, narration, details, status, owner, tally_guid, tally_master_id, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'tally', $14, $15, 'tally')`,
          [id, co, fy, vtype, base, txt(v.VOUCHERNUMBER), vdate, txt(v.PARTYLEDGERNAME), txt(v.REFERENCE), date(v.REFERENCEDATE), txt(v.NARRATION),
           { alterId, buyer: txt(v.BASICBUYERNAME), gstin: txt(v.PARTYGSTIN), placeOfSupply: txt(v.PLACEOFSUPPLY), dispatchDoc: txt(v.BASICSHIPDOCUMENTNO),
             dispatchedThrough: txt(v.BASICSHIPPEDBY), destination: txt(v.BASICFINALDESTINATION), terms: txt(v.BASICDUEDATEOFPYMT) },
           status, guid, txt(v.MASTERID)]);
        if (status !== "cancelled") {
          let line = 0;
          const party = norm(txt(v.PARTYLEDGERNAME));
          for (const e of list(v["ALLLEDGERENTRIES.LIST"])) {
            const ledger = txt(e.LEDGERNAME), amount = r2(-num(e.AMOUNT));
            if (!ledger || amount === 0) continue;
            const er = await c.query("INSERT INTO voucher_entries (voucher_id, line, ledger, amount, is_party) VALUES ($1, $2, $3, $4, $5) RETURNING id",
              [id, ++line, ledger, amount, norm(ledger) === party]);
            for (const b of list(e["BILLALLOCATIONS.LIST"])) {
              const bt = txt(b.BILLTYPE);
              if (!txt(b.NAME) || !["New Ref", "Agst Ref", "Advance", "On Account"].includes(bt)) continue;
              const days = num(b.BILLCREDITPERIOD);
              await c.query("INSERT INTO bill_allocations (entry_id, name, bill_type, amount, due_date) VALUES ($1, $2, $3, $4, $5)",
                [er.rows[0].id, txt(b.NAME), bt, r2(-num(b.AMOUNT)), days ? iso(new Date(Date.parse(vdate) + days * 86400e3)) : null]);
            }
            for (const b of list(e["BANKALLOCATIONS.LIST"])) {
              if (!txt(b.TRANSACTIONTYPE) && !txt(b.INSTRUMENTNUMBER) && !txt(b.BANKNAME)) continue;
              await c.query("INSERT INTO bank_allocations (entry_id, txn_type, instrument_no, instrument_date, bank_name) VALUES ($1, $2, $3, $4, $5)",
                [er.rows[0].id, txt(b.TRANSACTIONTYPE), txt(b.INSTRUMENTNUMBER), date(b.INSTRUMENTDATE), txt(b.BANKNAME)]);
            }
          }
          let iline = 0;
          for (const i of list(v["ALLINVENTORYENTRIES.LIST"])) {
            const item = txt(i.STOCKITEMNAME);
            if (!item) continue;
            const inward = yes(i.ISDEEMEDPOSITIVE);
            const q = txt(i.BILLEDQTY) || txt(i.ACTUALQTY);
            const qm = q.replace(/,/g, "").match(/(-?[\d.]+)\s*(.*)/);
            const rm = txt(i.RATE).replace(/,/g, "").match(/(-?[\d.]+)/);
            const batches = list(i["BATCHALLOCATIONS.LIST"]);
            await c.query(`INSERT INTO inventory_entries (voucher_id, line, item, godown, batch, qty, unit, rate, discount, amount, hsn)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [id, ++iline, item, txt(batches[0]?.GODOWNNAME), txt(batches[0]?.BATCHNAME),
               (inward ? 1 : -1) * Math.abs(qm ? Number(qm[1]) : 0), qm ? qm[2].trim() : "", rm ? Number(rm[1]) : 0, num(i.DISCOUNT),
               (inward ? 1 : -1) * Math.abs(num(i.AMOUNT)), txt(i.GSTHSNNAME)]);
          }
        }
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");   // checks this voucher balances now
        await c.query("SET CONSTRAINTS ALL DEFERRED");
        await c.query("RELEASE SAVEPOINT v");
        if (prev) changed++; else added++;
      } catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT v");
        failures.push(vtype + " " + txt(v.VOUCHERNUMBER) + " " + vdate + ": " + (e as Error).message);
      }
    }
    // vouchers that are no longer in Tally: kept, marked cancelled
    let gone = 0;
    for (const [guid, prev] of existing) {
      if (seen.has(guid)) continue;
      await c.query("UPDATE vouchers SET status = 'cancelled', details = details || '{\"removedInTally\": true}' WHERE id = $1 AND status <> 'cancelled'", [prev.id]);
      gone++;
    }
    await c.query("COMMIT");
    say(vouchers.length + " vouchers from " + booksFrom + ": " + added + " added, " + changed + " changed, " + same + " unchanged, " + gone + " no longer in Tally" + (skipped ? ", " + skipped + " optional/skipped" : ""));
    for (const f of failures.slice(0, 10)) say("  NOT SAVED  " + f);

    // ---- open bills, exactly as Tally's Bills Receivable report has them (the report the Windows app always read)
    const bxml = await post("<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Bills Receivable</REPORTNAME>" +
      "<STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>" + company.replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</SVCURRENTCOMPANY></STATICVARIABLES>" +
      "</REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>");
    const unesc = (x: string) => x.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim();
    const tdate = (x: string) => { const t = Date.parse(unesc(x).replace(/-(\d\d)$/, "-20$1")); return isNaN(t) ? "" : iso(new Date(t + 12 * 3600e3)); };
    const bills: { p: string; n: string; d: string; due: string; a: number; od: number }[] = [];
    for (const m of bxml.matchAll(/<BILLFIXED>([\s\S]*?)<\/BILLFIXED>([\s\S]*?)(?=<BILLFIXED>|<\/ENVELOPE>)/g)) {
      const tag = (src: string, t: string) => unesc((src.match(new RegExp("<" + t + ">([^<]*)</" + t + ">")) || [])[1] || "");
      const a = r2(-num(tag(m[2], "BILLCL")));
      if (!a) continue;
      bills.push({ p: tag(m[1], "BILLPARTY"), n: tag(m[1], "BILLREF"), d: tdate(tag(m[1], "BILLDATE")), due: tdate(tag(m[2], "BILLDUE")), a, od: Math.max(0, num(tag(m[2], "BILLOVERDUE"))) });
    }
    const bhash = createHash("sha256").update(JSON.stringify(bills)).digest("hex");
    const lastB = (await c.query("SELECT hash FROM tally_bill_snapshots WHERE company_id = $1 ORDER BY id DESC LIMIT 1", [co])).rows[0];
    if (lastB?.hash !== bhash) await c.query("INSERT INTO tally_bill_snapshots (company_id, hash, bills) VALUES ($1, $2, $3)", [co, bhash, JSON.stringify(bills)]);
    say(bills.filter((b) => b.a > 0).length + " open bills from Tally's Bills Receivable" + (lastB?.hash === bhash ? " (no change)" : ""));

    // ---- check: balance-sheet ledgers' closing balance against Tally's
    const ours = new Map((await c.query(`SELECT k.name, COALESCE((SELECT sum(o.amount) FROM ledger_openings o WHERE o.ledger_id = k.id), 0)
        + COALESCE((SELECT sum(x.amount) FROM live_entries x WHERE x.company_id = k.company_id AND x.ledger = k.name), 0) AS closing
      FROM ledger_kind k WHERE k.company_id = $1 AND NOT k.revenue`, [co])).rows.map((r) => [r.name as string, r2(Number(r.closing))]));
    const diffs: string[] = [];
    let checked = 0;
    for (const [name, closing] of ours) {
      // Tally adds the running profit into "Profit & Loss A/c", so its closing isn't a ledger movement
      if (!tallyClosing.has(name) || name === "Profit & Loss A/c") continue;
      checked++;
      const t = tallyClosing.get(name)!;
      if (Math.abs(t - closing) > 0.005) diffs.push(name + ": Tally " + t + ", mirror " + closing);
    }
    say("check: " + checked + " balance-sheet ledgers compared with Tally — " + (diffs.length ? diffs.length + " differ" : "all match"));
    for (const d of diffs.slice(0, 15)) say("  DIFFERS  " + d);
    await db.query("UPDATE sync_runs SET finished_at = now(), from_date = $2, to_date = $3, added = $4, changed = $5, ok = $6, totals = $7, error = $8 WHERE id = $1",
      [run, booksFrom, today, added, changed, failures.length === 0 && diffs.length === 0,
       { vouchers: vouchers.length, same, gone, failures: failures.length, ledgersChecked: checked, ledgersDiffer: diffs.length, differ: diffs.slice(0, 50) }, failures.slice(0, 20).join("\n")]);
    return { failures: failures.length, diffs: diffs.length, changed: added + changed + gone };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    await db.query("UPDATE sync_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1", [run, (e as Error).message]);
    throw e;
  } finally {
    c.release();
  }
}

// run the mirror for both companies (or one); used by the server every 15 minutes
export async function runMirror(db: pg.Pool, only?: Co, log: (s: string) => void = console.log) {
  const names = tallyCompanies();
  let bad = 0, changed = 0;
  for (const co of (["business", "cash"] as Co[]).filter((x) => !only || x === only)) {
    if (!names[co]) { log("No Tally company set for " + co); continue; }
    const r = await mirror(db, co, names[co], log);
    bad += r.failures + r.diffs; changed += r.changed;
  }
  return { bad, changed };
}

if (process.argv[1]?.endsWith("mirror-tally.ts")) {
  const db = pool(loadConfig());
  let bad = 0;
  try { bad = (await runMirror(db, process.argv[2] as Co | undefined)).bad; }
  finally { await db.end(); }
  console.log(bad ? "\nFinished with " + bad + " item(s) to look at (above)." : "\nTally mirror complete: everything matches.");
  process.exit(bad ? 1 : 0);
}
