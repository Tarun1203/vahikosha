// Home: a picture of the day, made of built-in widgets — what's owed (from
// Tally), how old the open bills are, who to chase, payments recorded, open
// orders and service jobs, Tally freshness, and a few more that start hidden.
// "Customize" shows / hides and reorders them; the choice is saved per login
// (settings/dashboard-<login>, logged in History). Plain figures, no AI.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { motion } from "motion/react";
import { IconAlertTriangle, IconArrowDown, IconArrowDownRight, IconArrowUp, IconArrowUpRight, IconCircleCheck, IconCloudOff, IconLayoutDashboard } from "@tabler/icons-react";
import { TextGenerateEffect } from "@/components/ui/text-generate-effect";
import { Button, Card, Icon3D, useToast } from "@/components/kit";
import { NAV } from "@/components/AppShell";
import { Columns, HBars, MUTED_MARK, RAMP4, Segmented, StatTile, shortInr } from "@/components/charts";
import { useTallyFreshness } from "@/components/TallyFreshness";
import { useStore } from "@/lib/store";
import { useCompanies, receiptTotal } from "@/lib/companies";
import { useTallyBills, syncedWhen } from "@/lib/tallydata";
import { ageOf, r2, receivableRows } from "@/lib/receivables";
import { listenDoc, saveRecord } from "@/lib/data";
import { greeting, inr, todayISO } from "@/lib/format";
import { msgDate } from "@/lib/messages";
import { cn } from "@/lib/utils";

// local yyyy-mm-dd, n days from today (dates are compared as text, never via UTC)
const dayISO = (back: number) => { const d = new Date(); d.setDate(d.getDate() - back); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const BUCKETS = [{ label: "0–30 days", max: 30 }, { label: "31–60 days", max: 60 }, { label: "61–90 days", max: 90 }, { label: "Over 90 days", max: Infinity }];
const OPEN_ORDERS = ["Pending", "Confirmed", "Packed", "Dispatched"];
const OPEN_JOBS = ["Received", "Under Service", "Ready to Return"];

function Widget({ title, note, children, className, to, toLabel }: { title: string; note?: string; children: ReactNode; className?: string; to?: string; toLabel?: string }) {
  return (
    <Card className={cn("flex h-full flex-col", className)}>
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
const Empty = ({ text }: { text: string }) => <p className="py-6 text-center text-sm text-neutral-400">{text}</p>;

// everything the widgets show, worked out once
function useFigures() {
  const { customers, balances, receipts, orders, services, settings } = useStore();
  const companies = useCompanies();
  const tallyBills = useTallyBills();
  const fresh = useTallyFreshness();
  const owe = useMemo(() => receivableRows(customers, balances, companies, tallyBills).filter((r) => r.total > 0), [customers, balances, companies, tallyBills]);
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
  const collections = useMemo(() => {
    const days = Array.from({ length: 30 }, (_, i) => dayISO(29 - i));
    const by = new Map(days.map((d) => [d, 0]));
    const modes = new Map<string, number>();
    let prev = 0, count = 0;
    const prevFrom = dayISO(59), from = days[0];
    for (const r of receipts) {
      if (r.cancelled || !r.date) continue;
      const v = receiptTotal(r);
      if (by.has(r.date)) { by.set(r.date, by.get(r.date)! + v); count++; modes.set(r.mode || "Other", (modes.get(r.mode || "Other") || 0) + v); }
      else if (r.date >= prevFrom && r.date < from) prev += v;
    }
    const data = days.map((d) => ({ key: d, label: msgDate(d).slice(0, 6), value: r2(by.get(d)!) }));
    return { data, total: r2(data.reduce((t, d) => t + d.value, 0)), prev: r2(prev), count, modes: [...modes].map(([m, v]) => ({ mode: m, value: r2(v) })).sort((a, b) => b.value - a.value) };
  }, [receipts]);
  return { companies, tallyBills, fresh, owe, ageing, collections, balances, orders, services, settings,
    owed: r2(owe.reduce((t, r) => t + r.total, 0)), overdue: r2(owe.reduce((t, r) => t + r.overdue, 0)),
    billsWhen: tallyBills ? syncedWhen(companies.map((co) => tallyBills[co.key]?.syncedAt).find(Boolean)) : "" };
}
type Figures = ReturnType<typeof useFigures>;

/* ---------------- the built-in widgets ---------------- */

function Headline({ f }: { f: Figures }) {
  const { collections: c } = f;
  const delta = c.prev > 0 ? Math.round(((c.total - c.prev) / c.prev) * 100) : null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile label="Owed to you" value={shortInr(f.owed)} sub={inr(f.owed) + " · all companies"} to="/receivables" />
      <StatTile label="Overdue (open bills)" value={f.tallyBills ? shortInr(f.overdue) : "…"} sub={f.tallyBills ? inr(f.overdue) : "loading invoices"} to="/receivables" tone={f.overdue > 0 ? "critical" : undefined} />
      <StatTile label="Parties owing" value={String(f.owe.length)} sub={f.fresh ? "From Tally · checked " + f.fresh.age + " ago" : "From Tally"} to="/receivables" />
      <StatTile label="Payments, last 30 days" value={shortInr(c.total)}
        sub={delta === null ? c.count + " recorded in the app" : <span className="inline-flex items-center gap-1">
          {delta >= 0 ? <IconArrowUpRight size={13} className="text-emerald-700" /> : <IconArrowDownRight size={13} className="text-rose-700" />}
          <span className={delta >= 0 ? "text-emerald-700" : "text-rose-700"}>{(delta >= 0 ? "+" : "") + delta + "%"}</span> vs the 30 days before</span>}
        to="/payment-updated" />
    </div>
  );
}

function Ageing({ f }: { f: Figures }) {
  return (
    <Widget title="Open bills by age" note={"Unpaid invoices from Tally" + (f.billsWhen ? ", synced " + f.billsWhen : "") + " — not the same as the balance (on-account payments aren't bills)"} to="/receivables" toLabel="Receivables">
      {!f.ageing ? <Loading what="Tally invoices" /> : f.ageing.every((a) => !a.count) ? <Empty text="No open invoices from Tally." /> : (
        <HBars rows={BUCKETS.map((b, i) => ({ key: b.label, label: b.label + " · " + f.ageing![i].count + " bill" + (f.ageing![i].count === 1 ? "" : "s"), value: f.ageing![i].amount, color: RAMP4[i],
          tip: <>{b.label}: <b>{inr(f.ageing![i].amount)}</b> in {f.ageing![i].count} bill{f.ageing![i].count === 1 ? "" : "s"}</> }))} />
      )}
    </Widget>
  );
}

function Chase({ f }: { f: Figures }) {
  const top = f.owe.filter((r) => r.overdue > 0).sort((a, b) => b.overdue - a.overdue).slice(0, 8);
  return (
    <Widget title="Who to chase" note="Biggest overdue amounts (open bills past their due date)" to="/receivables" toLabel="All">
      {!f.tallyBills ? <Loading what="Tally invoices" /> : !top.length ? <Empty text="Nothing overdue. 🎉" /> : (
        <HBars rows={top.map((r) => ({
          key: r.key, label: r.name + (r.oldest ? " · oldest bill " + r.oldest + " days" : ""), value: r.overdue,
          to: r.customer ? "/ledger?c=" + r.customer.id : undefined,
          tip: <>{r.name}: <b>{inr(r.overdue)}</b> overdue of {inr(r.total)}</>,
          aside: r.customer ? <Link to={"/payment-reminder?c=" + r.customer.id} className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100">Remind</Link> : undefined,
        }))} />
      )}
    </Widget>
  );
}

function Payments({ f }: { f: Figures }) {
  const c = f.collections;
  return (
    <Widget title="Payments recorded, last 30 days" note={"Recorded in the app (Payment Updated, orders, Tally Match) — " + inr(c.total) + " in " + c.count + " payment" + (c.count === 1 ? "" : "s") + (c.prev ? " · 30 days before: " + inr(c.prev) : "")} to="/payment-updated" toLabel="Payments">
      <Columns data={c.data} tip={(d) => <>{msgDate(d.key)}: <b>{inr(d.value)}</b></>} />
    </Widget>
  );
}

function Orders({ f }: { f: Figures }) {
  const month = todayISO().slice(0, 7);
  const count = (s: string) => f.orders.filter((o) => o.status === s).length;
  const delivered = f.orders.filter((o) => o.status === "Delivered" && (o.deliveryDate || o.date || "").startsWith(month)).length;
  const cancelled = f.orders.filter((o) => o.status === "Cancelled" && (o.date || "").startsWith(month)).length;
  return (
    <Widget title="Open orders" note={(delivered || cancelled) ? "This month: " + delivered + " delivered" + (cancelled ? ", " + cancelled + " cancelled" : "") : "By status"} to="/orders" toLabel="Orders">
      <div className="mb-2 text-2xl font-extrabold tabular-nums">{OPEN_ORDERS.reduce((t, s) => t + count(s), 0)}</div>
      <Segmented parts={OPEN_ORDERS.map((s, i) => ({ key: s, label: s, value: count(s), color: RAMP4[i] }))} />
    </Widget>
  );
}

function Jobs({ f }: { f: Figures }) {
  const month = todayISO().slice(0, 7);
  const open = f.services.filter((j) => OPEN_JOBS.includes(j.status));
  const old = open.filter((j) => j.receivedDate && ageOf(j.receivedDate) > 7).length;
  const sentBack = f.services.filter((j) => j.status === "Sent Back" && (j.sentDate || j.receivedDate || "").startsWith(month)).length;
  return (
    <Widget title="Service jobs in hand" note={sentBack ? "This month: " + sentBack + " sent back" : "By status"} to="/service-jobs" toLabel="Jobs">
      <div className="mb-2 flex items-baseline gap-3"><span className="text-2xl font-extrabold tabular-nums">{open.length}</span>
        {old > 0 && <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-800"><IconAlertTriangle size={13} /> {old} waiting over 7 days</span>}</div>
      <Segmented parts={OPEN_JOBS.map((s, i) => ({ key: s, label: s, value: open.filter((j) => j.status === s).length, color: RAMP4[i] }))} />
    </Widget>
  );
}

function TallyHealth({ f }: { f: Figures }) {
  const fr = f.fresh;
  return (
    <Widget title="Tally figures" note="Updated by the Windows app on the Tally PC" to="/tally" toLabel="Tally Match">
      {!fr ? <p className="text-sm text-neutral-500">No Tally figures yet — set up Tally Sync in the Windows app.</p> : (
        <div className="space-y-2 text-sm">
          <div className={cn("flex items-center gap-2 font-semibold", fr.stale || fr.problem ? "text-amber-800" : "text-emerald-700")}>
            {fr.stale || fr.problem ? <IconAlertTriangle size={18} /> : <IconCircleCheck size={18} />}
            {fr.problem ? "Problem at the last check" : fr.stale ? "Out of date" : "Up to date"}
            <span className="font-normal text-neutral-500">· checked {fr.age} ago</span>
          </div>
          {fr.problem && <p className="text-xs text-neutral-600">{fr.problem}</p>}
          {fr.stale && <p className="text-xs text-neutral-600">The Tally PC may be off or Tally closed.</p>}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-neutral-500">
            {f.companies.map((co) => <span key={co.key}><span className="inline-block size-2 rounded-full align-middle" style={{ background: f.balances[co.key] ? "#0ca30c" : MUTED_MARK }} /> {co.label}</span>)}
          </div>
        </div>
      )}
    </Widget>
  );
}

function ByRoute({ f }: { f: Figures }) {
  const routes = f.settings.routes || [];
  const by = new Map<string, number>();
  for (const r of f.owe) by.set(r.route, (by.get(r.route) || 0) + r.total);
  const rows = [...by].map(([code, v]) => ({ code, v: r2(v) })).sort((a, b) => b.v - a.v).slice(0, 10);
  const name = (code: string) => { const r = routes.find((x) => x.code === code); return r ? r.district + "-" + r.code + " · " + r.name : code || "No route"; };
  return (
    <Widget title="Owed by route" note="Balances from Tally, grouped by each party's route (Parties & codes)" to="/receivables" toLabel="Receivables">
      {!rows.length ? <Empty text="Nobody owes anything." /> : <HBars rows={rows.map((r) => ({ key: r.code || "-", label: name(r.code), value: r.v, tip: <>{name(r.code)}: <b>{inr(r.v)}</b></> }))} />}
    </Widget>
  );
}

function ByMode({ f }: { f: Figures }) {
  const m = f.collections.modes;
  return (
    <Widget title="Payments by mode, last 30 days" note="Cash, UPI, bank, cheque… as recorded in the app" to="/payment-updated" toLabel="Payments">
      {!m.length ? <Empty text="No payments recorded in the last 30 days." /> : <HBars rows={m.map((x) => ({ key: x.mode, label: x.mode, value: x.value, tip: <>{x.mode}: <b>{inr(x.value)}</b></> }))} />}
    </Widget>
  );
}

function Deliveries({ f }: { f: Figures }) {
  const today = todayISO(), week = dayISO(-7);
  const due = f.orders.filter((o) => o.deliveryDate && !["Delivered", "Cancelled"].includes(o.status) && o.deliveryDate <= week)
    .sort((a, b) => (a.deliveryDate || "").localeCompare(b.deliveryDate || ""));
  return (
    <Widget title="Deliveries due this week" note="Open orders with a delivery date in the next 7 days (or already past)" to="/orders" toLabel="Orders">
      {!due.length ? <Empty text="No deliveries due." /> : (
        <ul className="divide-y divide-neutral-100 text-sm">
          {due.slice(0, 8).map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-2 py-1.5">
              <span className="min-w-0 truncate"><b>{o.orderNo}</b> · {o.customerName}</span>
              <span className={cn("shrink-0 text-xs font-semibold", (o.deliveryDate || "") < today ? "text-rose-700" : "text-neutral-500")}>
                {(o.deliveryDate || "") < today ? <IconAlertTriangle size={12} className="mr-0.5 inline" /> : null}{msgDate(o.deliveryDate || "")} · {o.status}</span>
            </li>
          ))}
          {due.length > 8 && <li className="pt-1.5 text-xs text-neutral-500">+{due.length - 8} more</li>}
        </ul>
      )}
    </Widget>
  );
}

// size: how wide on a big screen (the grid has 6 columns); on phones every widget is full width
export const WIDGETS: { id: string; title: string; size: "full" | "half" | "third"; on: boolean; C: (p: { f: Figures }) => ReactNode }[] = [
  { id: "headline", title: "Headline figures (owed, overdue, parties, payments)", size: "full", on: true, C: Headline },
  { id: "ageing", title: "Open bills by age", size: "half", on: true, C: Ageing },
  { id: "chase", title: "Who to chase", size: "half", on: true, C: Chase },
  { id: "payments", title: "Payments recorded, last 30 days", size: "full", on: true, C: Payments },
  { id: "orders", title: "Open orders", size: "third", on: true, C: Orders },
  { id: "jobs", title: "Service jobs in hand", size: "third", on: true, C: Jobs },
  { id: "tally", title: "Tally figures (up to date?)", size: "third", on: true, C: TallyHealth },
  { id: "routes", title: "Owed by route", size: "half", on: false, C: ByRoute },
  { id: "modes", title: "Payments by mode", size: "half", on: false, C: ByMode },
  { id: "deliveries", title: "Deliveries due this week", size: "third", on: false, C: Deliveries },
];
const SPAN = { full: "lg:col-span-6", half: "lg:col-span-3", third: "lg:col-span-2" };

/* ---------------- the user's layout ---------------- */

// saved: the order and what's hidden (so widgets added later show up by themselves)
interface Layout { order: string[]; hidden: string[] }
const DEFAULT: Layout = { order: WIDGETS.map((w) => w.id), hidden: WIDGETS.filter((w) => !w.on).map((w) => w.id) };
const isDemo = () => import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
function arrange(l: Layout) {
  const known = l.order.filter((id) => WIDGETS.some((w) => w.id === id));
  const order = [...known, ...WIDGETS.map((w) => w.id).filter((id) => !known.includes(id))];
  return order.map((id) => ({ w: WIDGETS.find((x) => x.id === id)!, shown: !l.hidden.includes(id) }));
}

function useLayout() {
  const { user } = useStore();
  const docId = "dashboard-" + (user?.email || "me");
  const [saved, setSaved] = useState<(Layout & { id: string }) | null>(null);
  useEffect(() => {
    if (isDemo()) { try { const l = JSON.parse(localStorage.getItem("cem_demo_dashboard") || "null"); if (l) setSaved({ id: docId, ...l }); } catch { /* default */ } return; }
    if (!user) return;
    return listenDoc<Layout & { id: string }>("settings", docId, (d) => setSaved(d ? { ...d, id: docId } : null), () => { /* default layout */ });
  }, [user, docId]);
  async function save(l: Layout) {
    if (isDemo()) { try { localStorage.setItem("cem_demo_dashboard", JSON.stringify(l)); } catch { /* ignore */ } setSaved({ id: docId, ...l }); return; }
    await saveRecord("settings", { id: docId, order: l.order, hidden: l.hidden }, saved);
  }
  return { layout: saved ? { order: saved.order || DEFAULT.order, hidden: saved.hidden || [] } : DEFAULT, save };
}

function Customize({ layout, onDone, onCancel }: { layout: Layout; onDone: (l: Layout) => void; onCancel: () => void }) {
  const [rows, setRows] = useState(() => arrange(layout));
  const move = (i: number, d: number) => setRows((r) => { const n = [...r]; const j = i + d; if (j < 0 || j >= n.length) return r; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <Card className="mb-4 border-2 border-brand-200">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-extrabold">Customize the dashboard</h2>
          <p className="text-xs text-neutral-500">Tick the widgets to show and move them up or down. Saved for this login.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setRows(arrange(DEFAULT))}>Reset to default</Button>
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onDone({ order: rows.map((r) => r.w.id), hidden: rows.filter((r) => !r.shown).map((r) => r.w.id) })}>Done</Button>
        </div>
      </div>
      <ul className="divide-y divide-neutral-100">
        {rows.map((r, i) => (
          <li key={r.w.id} className="flex items-center gap-3 py-2 text-sm">
            <input type="checkbox" className="size-4 accent-brand-600" checked={r.shown} aria-label={"Show " + r.w.title}
              onChange={(e) => setRows((x) => x.map((y, j) => (j === i ? { ...y, shown: e.target.checked } : y)))} />
            <span className={cn("min-w-0 flex-1", !r.shown && "text-neutral-400")}>{r.w.title}</span>
            <button type="button" className="rounded p-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><IconArrowUp size={16} /></button>
            <button type="button" className="rounded p-1 text-neutral-500 hover:bg-neutral-100 disabled:opacity-30" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><IconArrowDown size={16} /></button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function Dashboard() {
  const { settings, synced } = useStore();
  const toast = useToast();
  const f = useFigures();
  const { layout, save } = useLayout();
  const [editing, setEditing] = useState(false);
  const shortcuts = NAV.flatMap((g) => g.items).filter((i) => i.to !== "/");
  const shown = arrange(layout).filter((r) => r.shown);

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

      <div className="mb-3 flex justify-end">
        {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}><IconLayoutDashboard size={16} /> Customize</Button>}
      </div>
      {editing && <Customize layout={layout} onCancel={() => setEditing(false)} onDone={async (l) => {
        setEditing(false);
        try { await save(l); toast("Dashboard saved."); } catch (e) { toast("Couldn't save the dashboard: " + (e as Error).message); }
      }} />}

      {!shown.length ? <Card className="mb-8 text-center text-sm text-neutral-500">All widgets are hidden — press Customize to show some.</Card> : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-8 grid gap-4 lg:grid-cols-6">
          {shown.map(({ w }) => <div key={w.id} className={SPAN[w.size]}><w.C f={f} /></div>)}
        </motion.div>
      )}

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
