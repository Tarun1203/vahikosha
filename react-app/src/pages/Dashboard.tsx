// Home: a picture of the day — what's owed (from Tally), how old the open bills
// are, who to chase, payments recorded this month, open orders and service
// jobs, and whether the Tally figures are fresh. Plain figures and charts, no
// AI; every widget links to the page behind it. Then the shortcuts.
import { useMemo } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { IconAlertTriangle, IconArrowDownRight, IconArrowUpRight, IconCircleCheck, IconCloudOff } from "@tabler/icons-react";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { Card, Icon3D } from "@/components/kit";
import { NAV } from "@/components/AppShell";
import { Columns, HBars, MUTED_MARK, RAMP4, Segmented, StatTile, shortInr } from "@/components/charts";
import { useTallyFreshness } from "@/components/TallyFreshness";
import { useStore } from "@/lib/store";
import { useCompanies, receiptTotal } from "@/lib/companies";
import { useTallyBills, syncedWhen } from "@/lib/tallydata";
import { ageOf, r2, receivableRows } from "@/lib/receivables";
import { greeting, inr, todayISO } from "@/lib/format";
import { msgDate } from "@/lib/messages";
import { cn } from "@/lib/utils";

// local yyyy-mm-dd, n days before today (dates are compared as text, never via UTC)
const dayISO = (back: number) => { const d = new Date(); d.setDate(d.getDate() - back); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const BUCKETS = [{ label: "0–30 days", max: 30 }, { label: "31–60 days", max: 60 }, { label: "61–90 days", max: 90 }, { label: "Over 90 days", max: Infinity }];
const OPEN_ORDERS = ["Pending", "Confirmed", "Packed", "Dispatched"];
const OPEN_JOBS = ["Received", "Under Service", "Ready to Return"];

function Widget({ title, note, children, className, to, toLabel }: { title: string; note?: string; children: React.ReactNode; className?: string; to?: string; toLabel?: string }) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-extrabold tracking-tight text-neutral-900">{title}</h2>
          {note && <p className="text-[11px] text-neutral-500">{note}</p>}
        </div>
        {to && <Link to={to} className="shrink-0 text-xs font-semibold text-brand-600 hover:underline">{toLabel || "Open"} →</Link>}
      </div>
      <div className="flex-1">{children}</div>
    </Card>
  );
}
const Loading = ({ what }: { what: string }) => <p className="py-6 text-center text-sm text-neutral-400">Loading {what}…</p>;

export function Dashboard() {
  const { customers, balances, settings, receipts, orders, services, synced } = useStore();
  const companies = useCompanies();
  const tallyBills = useTallyBills();
  const fresh = useTallyFreshness();
  const shortcuts = NAV.flatMap((g) => g.items).filter((i) => i.to !== "/");

  // receivables: exactly the List of receivables' figures (all companies, amounts owed)
  const owe = useMemo(() => receivableRows(customers, balances, companies, tallyBills).filter((r) => r.total > 0), [customers, balances, companies, tallyBills]);
  const owed = r2(owe.reduce((t, r) => t + r.total, 0));
  const overdue = r2(owe.reduce((t, r) => t + r.overdue, 0));
  const topOverdue = owe.filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 8);

  // open bills from Tally by age of the bill
  const ageing = useMemo(() => {
    if (!tallyBills) return null;
    const sums = BUCKETS.map(() => ({ amount: 0, count: 0 }));
    for (const co of companies) for (const b of tallyBills[co.key]?.bills || []) {
      if (!(b.a > 0)) continue;
      const i = BUCKETS.findIndex((x) => ageOf(b.d) <= x.max);
      sums[i].amount += b.a; sums[i].count++;
    }
    return sums.map((s) => ({ ...s, amount: r2(s.amount) }));
  }, [tallyBills, companies]);
  const billsWhen = tallyBills ? syncedWhen(companies.map((co) => tallyBills[co.key]?.syncedAt).find(Boolean)) : "";

  // payments recorded in the app: the last 30 days, day by day, and the 30 before
  const collections = useMemo(() => {
    const days = Array.from({ length: 30 }, (_, i) => dayISO(29 - i));
    const by = new Map(days.map((d) => [d, 0]));
    let prev = 0;
    const prevFrom = dayISO(59), from = days[0];
    for (const r of receipts) {
      if (r.cancelled || !r.date) continue;
      const v = receiptTotal(r);
      if (by.has(r.date)) by.set(r.date, by.get(r.date)! + v);
      else if (r.date >= prevFrom && r.date < from) prev += v;
    }
    const data = days.map((d) => ({ key: d, label: msgDate(d).slice(0, 6), value: r2(by.get(d)!) }));
    return { data, total: r2(data.reduce((t, d) => t + d.value, 0)), prev: r2(prev), count: receipts.filter((r) => !r.cancelled && r.date >= from).length };
  }, [receipts]);
  const delta = collections.prev > 0 ? Math.round(((collections.total - collections.prev) / collections.prev) * 100) : null;

  // open orders and service jobs
  const month = todayISO().slice(0, 7);
  const orderCount = (s: string) => orders.filter((o) => o.status === s).length;
  const delivered = orders.filter((o) => o.status === "Delivered" && (o.deliveryDate || o.date || "").startsWith(month)).length;
  const cancelled = orders.filter((o) => o.status === "Cancelled" && (o.date || "").startsWith(month)).length;
  const openJobs = services.filter((j) => OPEN_JOBS.includes(j.status));
  const oldJobs = openJobs.filter((j) => j.receivedDate && ageOf(j.receivedDate) > 7).length;
  const sentBack = services.filter((j) => j.status === "Sent Back" && (j.sentDate || j.receivedDate || "").startsWith(month)).length;

  const tallyNote = fresh ? "From Tally · checked " + fresh.age + " ago" : "From Tally";
  return (
    <div>
      <div className="relative mb-6 overflow-hidden rounded-3xl border border-brand-100 bg-[radial-gradient(circle_at_1px_1px,rgba(36,99,235,0.14)_1px,transparent_0)] [background-size:18px_18px] p-6 md:p-7">
        <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-gradient-to-br from-brand-200/60 to-violet-200/50 blur-3xl" />
        <div className="relative flex items-center justify-between gap-4">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] text-brand-600 uppercase">Welcome back</p>
            <h1 className="mt-1 bg-gradient-to-r from-neutral-900 via-brand-600 to-violet-600 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent md:text-4xl">
              {greeting()}, {settings.businessName}
            </h1>
            <TextGenerateEffect words="Today's picture: what's owed, who to chase, and the work in hand."
              className="mt-2 font-medium [&_*]:!text-[15px] [&_*]:!font-medium [&_*]:!text-neutral-500 [&>div]:!mt-0" duration={0.3} />
          </div>
          <Icon3D name="rocket" className="hidden h-24 w-24 animate-float drop-shadow-2xl md:block" />
        </div>
      </div>
      {!synced && <div className="mb-4 flex items-center gap-2 rounded-xl bg-neutral-100 px-3 py-2 text-xs font-medium text-neutral-600"><IconCloudOff size={15} /> Offline — showing the copy saved on this device.</div>}

      {/* headline figures */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Owed to you" value={shortInr(owed)} sub={inr(owed) + " · all companies"} to="/receivables" />
        <StatTile label="Overdue (open bills)" value={tallyBills ? shortInr(overdue) : "…"} sub={tallyBills ? inr(overdue) : "loading invoices"} to="/receivables" tone={overdue > 0 ? "critical" : undefined} />
        <StatTile label="Parties owing" value={String(owe.length)} sub={tallyNote} to="/receivables" />
        <StatTile label="Payments, last 30 days" value={shortInr(collections.total)}
          sub={delta === null ? collections.count + " recorded in the app" : <span className="inline-flex items-center gap-1">
            {delta >= 0 ? <IconArrowUpRight size={13} className="text-emerald-700" /> : <IconArrowDownRight size={13} className="text-rose-700" />}
            <span className={delta >= 0 ? "text-emerald-700" : "text-rose-700"}>{(delta >= 0 ? "+" : "") + delta + "%"}</span> vs the 30 days before</span>}
          to="/payment-updated" />
      </motion.div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Widget title="Open bills by age" note={"Unpaid invoices from Tally" + (billsWhen ? ", synced " + billsWhen : "") + " — not the same as the balance (on-account payments aren't bills)"} to="/receivables" toLabel="Receivables">
          {!ageing ? <Loading what="Tally invoices" /> : ageing.every((a) => !a.count) ? <p className="py-6 text-center text-sm text-neutral-400">No open invoices from Tally.</p> : (
            <HBars rows={BUCKETS.map((b, i) => ({ key: b.label, label: b.label + " · " + ageing[i].count + " bill" + (ageing[i].count === 1 ? "" : "s"), value: ageing[i].amount, color: RAMP4[i],
              tip: <>{b.label}: <b>{inr(ageing[i].amount)}</b> in {ageing[i].count} bill{ageing[i].count === 1 ? "" : "s"}</> }))} />
          )}
        </Widget>
        <Widget title="Who to chase" note="Biggest overdue amounts (open bills past their due date)" to="/receivables" toLabel="All">
          {!tallyBills ? <Loading what="Tally invoices" /> : !topOverdue.length ? <p className="py-6 text-center text-sm text-neutral-400">Nothing overdue. 🎉</p> : (
            <HBars rows={topOverdue.map((r) => ({
              key: r.key, label: r.name + (r.oldest ? " · oldest bill " + r.oldest + " days" : ""), value: r.overdue, color: "#2a78d6",
              to: r.customer ? "/ledger?c=" + r.customer.id : undefined,
              tip: <>{r.name}: <b>{inr(r.overdue)}</b> overdue of {inr(r.total)}</>,
              aside: r.customer ? <Link to={"/payment-reminder?c=" + r.customer.id} className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100">Remind</Link> : undefined,
            }))} />
          )}
        </Widget>
      </div>

      <Widget className="mb-4" title="Payments recorded, last 30 days" note={"Recorded in the app (Payment Updated, orders, Tally Match) — " + inr(collections.total) + " in " + collections.count + " payment" + (collections.count === 1 ? "" : "s") + (collections.prev ? " · 30 days before: " + inr(collections.prev) : "")} to="/payment-updated" toLabel="Payments">
          <Columns data={collections.data} tip={(d) => <>{msgDate(d.key)}: <b>{inr(d.value)}</b></>} />
      </Widget>

      <div className="mb-8 grid gap-4 lg:grid-cols-3">
        <Widget title="Open orders" note={(delivered || cancelled) ? "This month: " + delivered + " delivered" + (cancelled ? ", " + cancelled + " cancelled" : "") : "By status"} to="/orders" toLabel="Orders">
          <div className="mb-2 text-2xl font-extrabold tabular-nums">{OPEN_ORDERS.reduce((t, s) => t + orderCount(s), 0)}</div>
          <Segmented parts={OPEN_ORDERS.map((s, i) => ({ key: s, label: s, value: orderCount(s), color: RAMP4[i] }))} />
        </Widget>
        <Widget title="Service jobs in hand" note={sentBack ? "This month: " + sentBack + " sent back" : "By status"} to="/service-jobs" toLabel="Jobs">
          <div className="mb-2 flex items-baseline gap-3"><span className="text-2xl font-extrabold tabular-nums">{openJobs.length}</span>
            {oldJobs > 0 && <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800"><IconAlertTriangle size={13} /> {oldJobs} waiting over 7 days</span>}</div>
          <Segmented parts={OPEN_JOBS.map((s, i) => ({ key: s, label: s, value: openJobs.filter((j) => j.status === s).length, color: RAMP4[i] }))} />
        </Widget>
        <Widget title="Tally figures" note="Updated by the Windows app on the Tally PC" to="/tally" toLabel="Tally Match">
          {!fresh ? <p className="text-sm text-neutral-500">No Tally figures yet — set up Tally Sync in the Windows app.</p> : (
            <div className="space-y-2 text-sm">
              <div className={cn("flex items-center gap-2 font-semibold", fresh.stale || fresh.problem ? "text-amber-800" : "text-emerald-700")}>
                {fresh.stale || fresh.problem ? <IconAlertTriangle size={18} /> : <IconCircleCheck size={18} />}
                {fresh.problem ? "Problem at the last check" : fresh.stale ? "Out of date" : "Up to date"}
                <span className="font-normal text-neutral-500">· checked {fresh.age} ago</span>
              </div>
              {fresh.problem && <p className="text-xs text-neutral-600">{fresh.problem}</p>}
              {fresh.stale && <p className="text-xs text-neutral-600">The Tally PC may be off or Tally closed.</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
                {companies.map((co) => <span key={co.key}><span className="inline-block size-2 rounded-full align-middle" style={{ background: balances[co.key] ? "#0ca30c" : MUTED_MARK }} /> {co.label}</span>)}
              </div>
            </div>
          )}
        </Widget>
      </div>

      <h2 className="mb-4 text-lg font-extrabold tracking-tight">Go to</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {shortcuts.map((s, i) => (
          <motion.div key={s.to} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.02 }}>
            <Link to={s.to}
              className="group flex h-full flex-col gap-3 rounded-2xl border border-neutral-200/80 bg-white p-4 shadow-sm transition hover:-translate-y-1 hover:border-brand-200 hover:shadow-[0_14px_30px_-12px_rgba(36,99,235,0.35)]">
              <Icon3D name={s.icon} className="h-11 w-11 drop-shadow-md transition duration-300 group-hover:scale-110 group-hover:-rotate-6" />
              <span className="text-sm font-bold text-neutral-800">{s.label}</span>
            </Link>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
