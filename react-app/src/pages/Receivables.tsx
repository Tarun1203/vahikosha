// List of receivables: everyone who owes money, across every Tally company —
// each party once (its main and brand ledgers, and its differently spelled
// ledgers in each company, added up), with how old its oldest open bill is and
// how much is overdue. Filter by route, type, company, amount and age; share
// as a PDF, or download a CSV. Read-only.
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { IconBrandWhatsapp, IconDownload, IconNotebook } from "@tabler/icons-react";
import { Button, Card, EmptyState, PageHeader, useToast } from "@/components/kit";
import { Select, Text } from "@/components/forms";
import { TallyFreshness } from "@/components/TallyFreshness";
import { useStore } from "@/lib/store";
import { logEvent, normalizeName, PARTY_KINDS, type Customer } from "@/lib/data";
import { useCompanies } from "@/lib/companies";
import { balanceIn, ledgersIn, partyKey } from "@/lib/parties";
import { billsOfLedger, useTallyBills, type TallyBill } from "@/lib/tallydata";
import { inr, todayISO } from "@/lib/format";
import { msgDate } from "@/lib/messages";
import { lib, plain, safeFileName, sharePdf, type Doc } from "@/lib/pdf";
import { cn } from "@/lib/utils";

interface Row {
  key: string; customer?: Customer; name: string; code: string; route: string; place: string; kind: string; mobile: string;
  per: Record<string, number>; total: number; oldest: number; overdue: number; bills: number;
}
const ageOf = (iso: string) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400e3)) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function Receivables() {
  const { customers, balances, settings } = useStore();
  const companies = useCompanies();
  const tallyBills = useTallyBills();
  const toast = useToast();
  const routes = settings.routes || [];
  const [q, setQ] = useState("");
  const [route, setRoute] = useState("all");
  const [kind, setKind] = useState("all");
  const [age, setAge] = useState("0");
  const [min, setMin] = useState("");
  const [sort, setSort] = useState<"amount" | "age" | "name" | "code">("amount");
  const [byRoute, setByRoute] = useState(true);
  const [credits, setCredits] = useState(false);
  const [off, setOff] = useState<string[]>([]);   // companies left out
  const cos = companies.filter((c) => !off.includes(c.key));

  // every party with a balance: the app's customers (all their ledgers), then Tally ledgers not in the app
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const used = new Map(companies.map((c) => [c.key, new Set<string>()]));
    const billsIn = (company: string, ledger: string): TallyBill[] => billsOfLedger(tallyBills, company, ledger);
    const add = (r: Omit<Row, "total" | "oldest" | "overdue" | "bills">, ledgers: { company: string; ledger: string }[]) => {
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
  }, [customers, balances, companies, tallyBills]);

  // what's shown: only the chosen companies count
  const view = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return rows.map((r) => {
      const per = Object.fromEntries(Object.entries(r.per).filter(([k]) => cos.some((c) => c.key === k)));
      return { ...r, per, total: r2(Object.values(per).reduce((t, v) => t + v, 0)) };
    }).filter((r) => r.total !== 0 && (credits ? true : r.total > 0))
      .filter((r) => route === "all" || (route === "none" ? !r.route : r.route === route))
      .filter((r) => kind === "all" || r.kind === kind)
      .filter((r) => !Number(age) || r.oldest > Number(age))
      .filter((r) => !min || Math.abs(r.total) >= Number(min))
      .filter((r) => !ql || (r.name + " " + r.code + " " + r.mobile).toLowerCase().includes(ql))
      .sort((a, b) => sort === "amount" ? b.total - a.total : sort === "age" ? b.oldest - a.oldest || b.total - a.total
        : sort === "code" ? (a.code || "~").localeCompare(b.code || "~") || a.name.localeCompare(b.name) : a.name.localeCompare(b.name));
  }, [rows, cos, q, route, kind, age, min, sort, credits]);   // eslint-disable-line react-hooks/exhaustive-deps

  const owe = view.filter((r) => r.total > 0), adv = view.filter((r) => r.total < 0);
  const sum = (list: Row[], k?: string) => r2(list.reduce((t, r) => t + (k ? r.per[k] || 0 : r.total), 0));
  const routeName = (code: string) => { const r = routes.find((x) => x.code === code); return r ? r.district + "-" + r.code + " · " + r.name : code ? code : "No route"; };
  const groups = byRoute
    ? [...new Set(owe.map((r) => r.route))].sort((a, b) => (a || "~").localeCompare(b || "~")).map((g) => ({ title: routeName(g), list: owe.filter((r) => r.route === g) }))
    : [{ title: "", list: owe }];
  const kindLabel = (k: string) => (k === "notinapp" ? "Not in the app" : PARTY_KINDS.find((x) => x.value === k)?.label || "Dealer");
  const asOn = msgDate(todayISO());

  async function makePdf() {
    const { jsPDF, autoTable } = await lib();
    const wide = cos.length > 2;
    const doc = new jsPDF({ unit: "mm", format: "a4", orientation: wide ? "landscape" : "portrait" }) as Doc;
    const W = doc.internal.pageSize.getWidth();
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.text(plain(settings.businessName || "Chittam Enterprises"), W / 2, 13, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    if (settings.address) doc.text(plain(settings.address).split("\n")[0].slice(0, 110), W / 2, 18, { align: "center" });
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("List of Receivables", W / 2, 25, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    const filters = [route !== "all" ? "Route: " + (route === "none" ? "No route" : routeName(route)) : "", kind !== "all" ? "Type: " + kindLabel(kind) : "",
      Number(age) ? "Oldest bill over " + age + " days" : "", min ? "At least Rs. " + min : "", off.length ? "Companies: " + cos.map((c) => c.label).join(", ") : ""].filter(Boolean).join(" · ");
    doc.text("As on " + asOn + (filters ? " · " + filters : ""), W / 2, 30, { align: "center" });
    const money = (n: number) => (n ? (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "");
    const head = [["#", "Code", "Party", ...cos.map((c) => plain(c.label)), "Total", "Oldest", "Overdue"]];
    let n = 0;
    const body: unknown[][] = [];
    for (const g of groups) {
      if (byRoute) body.push([{ content: plain(g.title), colSpan: head[0].length, styles: { fontStyle: "bold", fillColor: [238, 242, 255] } }]);
      for (const r of g.list) body.push([++n, r.code, plain(r.name) + (r.mobile ? "\n" + r.mobile : ""), ...cos.map((c) => money(r.per[c.key] || 0)), money(r.total), r.oldest ? r.oldest + " d" : "", money(r.overdue)]);
      if (byRoute && groups.length > 1) body.push(["", "", { content: "Route total", styles: { fontStyle: "bold" } }, ...cos.map((c) => ({ content: money(sum(g.list, c.key)), styles: { fontStyle: "bold" } })), { content: money(sum(g.list)), styles: { fontStyle: "bold" } }, "", ""]);
    }
    const foot = [["", "", "Grand total (" + owe.length + " parties)", ...cos.map((c) => money(sum(owe, c.key))), money(sum(owe)), "", money(r2(owe.reduce((t, r) => t + r.overdue, 0)))]];
    const right = Object.fromEntries([...cos.map((_, i) => i + 3), cos.length + 3, cos.length + 5].map((i) => [i, { halign: "right" }]));
    autoTable(doc, { startY: 34, head, body, foot, showFoot: "lastPage", theme: "grid", margin: { left: 10, right: 10 },
      styles: { fontSize: 7.8, cellPadding: 1.3, valign: "top" }, headStyles: { fillColor: [67, 56, 202], textColor: 255 },
      footStyles: { fillColor: [238, 242, 255], textColor: [30, 27, 120], fontStyle: "bold" },
      columnStyles: { 0: { cellWidth: 8 }, 1: { cellWidth: 26 }, ...right, [cos.length + 4]: { halign: "right", cellWidth: 14 } } });
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(120); doc.text("From Tally · Dr balances owed to " + plain(settings.businessName || "us") + " · page " + i + " of " + pages, 10, doc.internal.pageSize.getHeight() - 6); }
    return new Blob([doc.output("arraybuffer")], { type: "application/pdf" });
  }
  async function sharePdfNow() {
    if (!owe.length) { toast("Nothing to share."); return; }
    try {
      const r = await sharePdf(await makePdf(), safeFileName("Receivables " + todayISO() + (route !== "all" && route !== "none" ? " " + route : "")) + ".pdf", { kind: "Ledgers", text: "List of receivables – " + (settings.businessName || "") });
      if (r.message) toast(r.message);
      logEvent("receivables-pdf-shared", { parties: owe.length, total: sum(owe), route, kind }).catch(() => {});
    } catch (e) { toast("Could not make the PDF: " + (e as Error).message); }
  }
  function csv() {
    const q2 = (s: unknown) => '"' + String(s ?? "").replace(/"/g, '""') + '"';
    const lines = [["Code", "Party", "Type", "Route", "Place", "Mobile", ...cos.map((c) => c.label), "Total", "Oldest bill (days)", "Overdue"].map(q2).join(",")];
    for (const r of [...owe, ...adv]) lines.push([r.code, r.name, kindLabel(r.kind), r.route, r.place, r.mobile, ...cos.map((c) => r.per[c.key] || 0), r.total, r.oldest || "", r.overdue].map(q2).join(","));
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "receivables-" + todayISO() + ".csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    logEvent("receivables-csv", { parties: owe.length }).catch(() => {});
  }

  // the columns on wider screens (party, a column per company, total); on phones each row stacks
  const cols = { ["--cols" as string]: "minmax(0,1fr) " + cos.map(() => "7.5rem").join(" ") + " 8rem" } as React.CSSProperties;
  const grid = "sm:[grid-template-columns:var(--cols)]";
  return (
    <div>
      <PageHeader icon="notebook" eyebrow="Reports" title="List of receivables" subtitle="Everyone who owes money, across every Tally company — each party once, with its oldest open bill and overdue amount."
        actions={<><Button variant="whatsapp" size="sm" onClick={sharePdfNow}><IconBrandWhatsapp size={16} /> PDF</Button><Button variant="secondary" size="sm" onClick={csv}><IconDownload size={16} /> CSV</Button></>} />
      <TallyFreshness what="Tally balances" />
      <Card className="mb-4 space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {companies.map((c) => {
            const on = !off.includes(c.key);
            return <button key={c.key} type="button" aria-pressed={on} onClick={() => setOff(on ? [...off, c.key] : off.filter((x) => x !== c.key))}
              className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", on ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-dashed border-neutral-300 text-neutral-400 line-through")}>{on ? "☑" : "☐"} {c.icon} {c.label}</button>;
          })}
        </div>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Text className="sm:col-span-3 lg:col-span-2" placeholder="Search name, code or mobile…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Select value={route} onChange={setRoute} options={[{ value: "all", label: "Every route" }, ...routes.map((r) => ({ value: r.code, label: r.district + "-" + r.code + " · " + r.name })), { value: "none", label: "No route" }]} />
          <Select value={kind} onChange={setKind} options={[{ value: "all", label: "Every type" }, ...PARTY_KINDS.map((k) => ({ value: k.value, label: k.label })), { value: "notinapp", label: "Not in the app" }]} />
          <Select value={age} onChange={setAge} options={[{ value: "0", label: "Any age" }, { value: "30", label: "Oldest bill > 30 days" }, { value: "60", label: "> 60 days" }, { value: "90", label: "> 90 days" }, { value: "180", label: "> 180 days" }]} />
          <Text type="number" inputMode="numeric" placeholder="Min ₹" value={min} onChange={(e) => setMin(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <Select className="w-auto" value={sort} onChange={(v) => setSort(v as typeof sort)} options={[{ value: "amount", label: "Biggest first" }, { value: "age", label: "Oldest bill first" }, { value: "code", label: "By code" }, { value: "name", label: "By name" }]} />
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" className="size-4 accent-brand-600" checked={byRoute} onChange={(e) => setByRoute(e.target.checked)} /> Group by route</label>
          <label className="flex items-center gap-2 font-medium"><input type="checkbox" className="size-4 accent-brand-600" checked={credits} onChange={(e) => setCredits(e.target.checked)} /> Also show advances (credit balances)</label>
        </div>
      </Card>

      {/* totals */}
      <Card className="mb-4 border-2 border-brand-200 bg-brand-50/40">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {cos.map((c) => <span key={c.key}><span className="text-neutral-500">{c.icon} {c.label}</span> <b className="tabular-nums">{inr(sum(owe, c.key))}</b></span>)}
            <span><span className="text-neutral-500">Overdue</span> <b className="tabular-nums text-rose-700">{inr(r2(owe.reduce((t, r) => t + r.overdue, 0)))}</b></span>
          </div>
          <div className="text-right"><p className="text-xs font-bold uppercase tracking-wide text-neutral-500">{owe.length} parties owe</p><p className="text-2xl font-extrabold tabular-nums text-brand-700">{inr(sum(owe))}</p></div>
        </div>
      </Card>

      {!owe.length && !adv.length ? <EmptyState icon="notebook" title="Nobody to show" text="No receivables match these filters." /> : null}
      {groups.filter((g) => g.list.length).map((g) => (
        <Card key={g.title || "all"} className="mb-4 p-0">
          {byRoute && <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5 text-sm font-extrabold"><span>{g.title}</span><span className="tabular-nums">{inr(sum(g.list))}</span></div>}
          <div className={cn("hidden border-b border-neutral-100 px-4 py-2 text-[11px] font-bold uppercase tracking-wide text-neutral-500 sm:grid sm:gap-3", grid)} style={cols}>
            <span>Party</span>{cos.map((c) => <span key={c.key} className="text-right">{c.label}</span>)}<span className="text-right">Total</span>
          </div>
          <div className="divide-y divide-neutral-100">
            {g.list.map((r) => (
              <div key={r.key} className={cn("grid grid-cols-1 gap-1 px-4 py-2.5 text-sm sm:items-center sm:gap-3", grid)} style={cols}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{r.name}</span>
                    {r.customer && <Link to={"/ledger?c=" + r.customer.id} title="Ledger statement" className="shrink-0 text-neutral-400 hover:text-brand-700"><IconNotebook size={15} /></Link>}
                  </div>
                  <p className="text-xs text-neutral-500">{[r.code, kindLabel(r.kind), r.mobile].filter(Boolean).join(" · ")}
                    {r.oldest ? <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 font-bold", r.overdue ? "bg-rose-50 text-rose-700" : "bg-neutral-100 text-neutral-600")}>{r.oldest} days{r.overdue ? " · " + inr(r.overdue) + " overdue" : ""}</span> : null}</p>
                </div>
                {cos.map((c) => <span key={c.key} className={cn("text-xs tabular-nums text-neutral-600 sm:block sm:text-right sm:text-sm", !r.per[c.key] && "hidden")}><span className="sm:hidden">{c.label}: </span>{r.per[c.key] ? inr(r.per[c.key]) : "—"}</span>)}
                <span className="font-bold tabular-nums sm:text-right">{inr(r.total)}</span>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {credits && adv.length > 0 && (
        <Card className="p-0">
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-2.5 text-sm font-extrabold"><span>Advances (credit balances) — you owe them</span><span className="tabular-nums text-emerald-700">{inr(-sum(adv))}</span></div>
          <div className="divide-y divide-neutral-100">{adv.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-3 px-4 py-2 text-sm"><span className="min-w-0 truncate">{r.name}<span className="ml-2 text-xs text-neutral-500">{r.code}</span></span><span className="tabular-nums text-emerald-700">{inr(-r.total)} Cr</span></div>
          ))}</div>
        </Card>
      )}
    </div>
  );
}
