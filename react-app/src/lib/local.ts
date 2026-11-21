// The local server backend (PostgreSQL on the office PC), used when the app is
// started with VITE_BACKEND=local (npm run dev:local). Same functions as the
// Firebase ones in data.ts / store.tsx, so no page changes.
import { cacheGet, cachePut, isOffline, outboxAdd, outboxAll, outboxChanged, outboxDone, type Pending } from "./offline";

export const LOCAL = import.meta.env.VITE_BACKEND === "local";
// the Android app (built with npm run build:android)
export const NATIVE = import.meta.env.VITE_NATIVE === "1";

// the server: in the Android app, the office PC's address chosen at sign-in
// (its Tailscale name, e.g. http://office-pc:8484); on this PC while testing
const SERVER_KEY = "chittam.server";
export function serverAddress() {
  if (NATIVE) { try { return localStorage.getItem(SERVER_KEY) || ""; } catch { return ""; } }
  return (import.meta.env.VITE_SERVER as string | undefined) || (location.port === "5173" ? "http://127.0.0.1:8484" : "");
}
export function setServerAddress(a: string) {
  let v = a.trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\//i.test(v)) v = "http://" + v;
  if (v && !/:\d+$/.test(v.replace(/^https?:\/\//i, ""))) v += ":8484";
  try { localStorage.setItem(SERVER_KEY, v); } catch { /* ignore */ }
  return v;
}
const TOKEN_KEY = "chittam.token";

let token = "";
try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch { /* private window */ }
const saveToken = (t: string) => { token = t; try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export interface LocalUser { uid: string; email: string; displayName?: string; role?: string }
let current: LocalUser | null = null;
const authSubs = new Set<(u: LocalUser | null) => void>();
const emitAuth = () => authSubs.forEach((f) => f(current));

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(serverAddress() + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(init.headers || {}) },
  });
  if (res.status === 401 && path !== "/api/login") { saveToken(""); if (current) { current = null; emitAuth(); } }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || "Server error " + res.status);
  return body as T;
}

// ---------------------------------------------------------------- sign-in
export const currentUser = () => current;

export function onAuth(cb: (u: LocalUser | null) => void) {
  authSubs.add(cb);
  if (!token) cb(null);
  else api<{ id: string; email: string; displayName: string; role: string }>("/api/me")
    .then((u) => { current = { uid: u.id, email: u.email, displayName: u.displayName, role: u.role }; cachePut("me", current); emitAuth(); flushOutbox(); })
    .catch(async (e) => {
      // no connection to the office PC: stay signed in with the saved copy
      const saved = isOffline(e) ? await cacheGet<LocalUser>("me") : undefined;
      current = saved || null; emitAuth();
    });
  return () => { authSubs.delete(cb); };
}

export async function signIn(email: string, password: string) {
  const r = await api<{ token: string; user: { id: string; email: string; displayName: string; role: string } }>("/api/login", {
    method: "POST", body: JSON.stringify({ email, password, device: navigator.userAgent }),
  });
  saveToken(r.token);
  current = { uid: r.user.id, email: r.user.email, displayName: r.user.displayName, role: r.user.role };
  cachePut("me", current);
  emitAuth();
  flushOutbox();
}

export async function signOut() {
  try { await api("/api/logout", { method: "POST" }); } catch { /* signed out anyway */ }
  saveToken(""); current = null; closeEvents(); emitAuth();
}

// ---------------------------------------------------------------- live updates
let es: EventSource | null = null;
const subs = new Map<string, Set<() => void>>();
function ensureEvents() {
  if (es || !token) return;
  es = new EventSource(serverAddress() + "/api/events?token=" + encodeURIComponent(token));
  es.onmessage = (e) => {
    try { const d = JSON.parse(e.data) as { collection?: string }; if (d.collection) subs.get(d.collection)?.forEach((f) => f()); }
    catch { /* ignore */ }
  };
  // after a dropped connection: send what waited, then reload everything
  es.onopen = () => { flushOutbox().finally(() => subs.forEach((set) => set.forEach((f) => f()))); };
}
function closeEvents() { es?.close(); es = null; }
const changed = (collection: string) => subs.get(collection)?.forEach((f) => f());
export function onChange(collection: string, f: () => void) {
  if (!subs.has(collection)) subs.set(collection, new Set());
  subs.get(collection)!.add(f);
  ensureEvents();
  return () => { subs.get(collection)?.delete(f); };
}

// ---------------------------------------------------------------- records
const META = ["createdAt", "createdBy", "updatedAt", "updatedBy", "version"];
const clean = <T,>(r: Record<string, unknown>) => { const o = { ...r }; META.forEach((k) => delete o[k]); return o as T; };

// saves still waiting in the outbox, laid over what the server / saved copy has
async function withPending(name: string, rows: Record<string, unknown>[]) {
  const pend = (await outboxAll()).filter((p) => p.kind === "record" && p.coll === name);
  if (!pend.length) return rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const p of pend) byId.set(p.id, { ...(byId.get(p.id) || {}), ...p.data, id: p.id });
  return [...byId.values()];
}

export function listenCollection<T>(name: string, cb: (items: T[], fromCache: boolean) => void, onError?: (e: Error) => void) {
  let alive = true;
  const load = () => api<Record<string, unknown>[]>("/api/" + name)
    .then(async (rows) => { cachePut("coll:" + name, rows); const all = await withPending(name, rows); if (alive) cb(all.map((r) => clean<T>(r)), false); })
    .catch(async (e) => {
      // no connection: the saved copy (plus what's waiting to be sent)
      const saved = isOffline(e) ? await cacheGet<Record<string, unknown>[]>("coll:" + name) : undefined;
      if (saved && alive) cb((await withPending(name, saved)).map((r) => clean<T>(r)), true);
      else onError?.(e);
    });
  load();
  const off = onChange(name, load);
  return () => { alive = false; off(); };
}

export function listenDoc<T>(path: string, id: string, cb: (data: T | null) => void, onError?: (e: Error) => void) {
  let alive = true;
  const key = "doc:" + path + "/" + id;
  const load = () => api<Record<string, unknown>>("/api/" + path + "/" + encodeURIComponent(id))
    .then(async (r) => { cachePut(key, r); const [x] = await withPending(path, [r]); if (alive) cb(clean<T>(x)); })
    .catch(async (e) => {
      if (!alive) return;
      if (/not found/i.test((e as Error).message)) { cb(null); return; }
      const saved = isOffline(e) ? await cacheGet<Record<string, unknown>>(key) : undefined;
      if (saved) { const [x] = await withPending(path, [saved]); cb(clean<T>(x)); } else onError?.(e);
    });
  load();
  const off = onChange(path, load);
  return () => { alive = false; off(); };
}

// each save carries a unique entry key, so a retry never saves twice
const entryKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
// one save sent to the server
function send(p: Pending) {
  if (p.kind === "event") return api("/api/activity", { method: "POST", body: JSON.stringify(p.data), headers: { "X-Entry-Key": p.entryKey } });
  return api("/api/" + p.coll + "/" + encodeURIComponent(p.id), { method: "PUT", body: JSON.stringify(p.data), headers: { "X-Entry-Key": p.entryKey } });
}
// sent now, or kept in the outbox when the office PC can't be reached
async function sendOrQueue(p: Pending) {
  if (!(await outboxAll()).length) {
    try { await send(p); return; }
    catch (e) { if (!isOffline(e)) throw e; }
  }
  await outboxAdd(p);
  await outboxChanged();
  if (p.kind === "record") changed(p.coll);   // the pages show it straight away
}

let flushing: Promise<void> | null = null;
// sends what waited, oldest first; stops at the first sign of no connection
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const p of await outboxAll()) {
      try { await send(p); }
      catch (e) {
        if (isOffline(e)) break;
        // refused by the server: kept aside on the phone, never lost
        const failed = (await cacheGet<Pending[]>("outbox-failed")) || [];
        await cachePut("outbox-failed", [...failed, { ...p, error: (e as Error).message }]);
      }
      await outboxDone(p.seq!);
      if (p.kind === "record") changed(p.coll);
    }
    await outboxChanged();
  })().finally(() => { flushing = null; });
  return flushing;
}
if (typeof window !== "undefined" && LOCAL) {
  window.addEventListener("online", () => { flushOutbox(); });
  setInterval(() => { if (token) flushOutbox(); }, 30000);
}

const now = () => new Date().toISOString();
export async function saveRecords(writes: { coll: string; id: string; data: Record<string, unknown> }[]) {
  for (const w of writes) await sendOrQueue({ kind: "record", coll: w.coll, id: w.id, data: clean(w.data), entryKey: entryKey(), at: now() });
}

export async function logEvent(action: string, details: Record<string, unknown>) {
  await sendOrQueue({ kind: "event", coll: "activity", id: "", data: { collection: "app", action, name: details.name || details.customerName || "", details }, entryKey: entryKey(), at: now() });
}

export async function saveMessage(id: string, msg: Record<string, unknown>) {
  await sendOrQueue({ kind: "message", coll: "messages", id, data: msg, entryKey: entryKey(), at: now() });
}

// dates as the pages expect them (they call .toDate())
const stamp = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? { toDate: () => new Date(v), seconds: Math.floor(Date.parse(v) / 1000) } : v ?? null);
export async function loadLatest<T>(coll: "activity" | "messages", count = 300) {
  let rows: Record<string, unknown>[];
  try { rows = await api<Record<string, unknown>[]>("/api/history?coll=" + coll + "&limit=" + count); cachePut("hist:" + coll, rows); }
  catch (e) { const saved = isOffline(e) ? await cacheGet<Record<string, unknown>[]>("hist:" + coll) : undefined; if (!saved) throw e; rows = saved; }
  return rows.map((r) => ({ ...r, at: stamp(r.at) }) as T);
}

// ---------------------------------------------------------------- Tally figures (from the mirror)
export async function loadTally<T>(kind: "balances" | "vouchers" | "bills" | "stock"): Promise<T> {
  try { const r = await api<T>("/api/tally/" + kind); cachePut("tally:" + kind, r); return r; }
  catch (e) { const saved = isOffline(e) ? await cacheGet<T>("tally:" + kind) : undefined; if (saved === undefined) throw e; return saved; }
}
export const syncTallyNow = () => api<{ ok: boolean; changed?: number; error?: string }>("/api/tally/sync", { method: "POST" });
