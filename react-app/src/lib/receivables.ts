// Who owes money, across every Tally company: one row per party (its main and
// brand ledgers, and its differently spelled ledgers in each company, added
// up), with its oldest open bill and how much is overdue. Tally ledgers with a
// balance that no customer is linked to come as "notinapp". Shared by the List
// of receivables and the dashboard, so both always show the same figures.
import { normalizeName, type BalanceSet, type Customer } from "./data";
import { balanceIn, ledgersIn, partyKey } from "./parties";
import { billsOfLedger, type BillSet, type TallyBill } from "./tallydata";
import type { Company } from "./companies";

export interface ReceivableRow {
  key: string; customer?: Customer; name: string; code: string; route: string; place: string; kind: string; mobile: string;
  per: Record<string, number>; total: number; oldest: number; overdue: number; bills: number;
}
// days since an ISO date (yyyy-mm-dd), counted in local days
export const ageOf = (iso: string) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400e3)) : 0);
export const r2 = (n: number) => Math.round(n * 100) / 100;

export function receivableRows(customers: Customer[], balances: Record<string, BalanceSet>, companies: Pick<Company, "key">[], tallyBills: Record<string, BillSet> | null): ReceivableRow[] {
  const out: ReceivableRow[] = [];
  const used = new Map(companies.map((c) => [c.key, new Set<string>()]));
  const billsIn = (company: string, ledger: string): TallyBill[] => billsOfLedger(tallyBills, company, ledger);
  const add = (r: Omit<ReceivableRow, "total" | "oldest" | "overdue" | "bills">, ledgers: { company: string; ledger: string }[]) => {
    const bills = ledgers.flatMap((l) => billsIn(l.company, l.ledger));
    const dates = bills.map((b) => b.d).filter(Boolean).sort();
    out.push({ ...r, total: r2(Object.values(r.per).reduce((t, v) => t + v, 0)), oldest: dates.length ? ageOf(dates[0]) : 0,
      overdue: r2(bills.filter((b) => b.od > 0).reduce((t, b) => t + b.a, 0)), bills: bills.length });
  };
  for (const c of customers) {
    const per: Record<string, number> = {};
    const ledgers: { company: string; ledger: string }[] = [];
    for (const co of companies) {
      const v = balanceIn(balances[co.key], c, co.key);
      for (const l of ledgersIn(c, co.key)) { used.get(co.key)!.add(normalizeName(l.ledger)); ledgers.push({ company: co.key, ledger: l.ledger }); }
      if (v) per[co.key] = v;
    }
    if (!Object.keys(per).length) continue;
    add({ key: c.id, customer: c, name: c.name, code: c.code || "", route: c.route || "", place: c.place || "", kind: c.kind || "customer", mobile: c.mobile || "", per }, ledgers);
  }
  // Tally ledgers with a balance that no customer is linked to (shown as "not in the app")
  const appKeys = new Set(customers.map((c) => partyKey(c.name)));
  const orphan = new Map<string, { name: string; per: Record<string, number>; ledgers: { company: string; ledger: string }[] }>();
  for (const co of companies) {
    const b = balances[co.key];
    for (const [k, v] of Object.entries(b?.balances || {})) {
      if (!v || used.get(co.key)!.has(k) || appKeys.has(partyKey(k))) continue;
      const name = b?.names?.[k] || k;
      const id = partyKey(name);
      const o = orphan.get(id) || { name, per: {}, ledgers: [] };
      o.per[co.key] = r2((o.per[co.key] || 0) + v); o.ledgers.push({ company: co.key, ledger: name });
      orphan.set(id, o);
    }
  }
  for (const [id, o] of orphan) add({ key: "t:" + id, name: o.name, code: "", route: "", place: "", kind: "notinapp", mobile: "", per: o.per }, o.ledgers);
  return out;
}
