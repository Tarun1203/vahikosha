// The local server backend (PostgreSQL on the office PC), used when the app is
// started with VITE_BACKEND=local (npm run dev:local). Same functions as the
// Firebase ones in data.ts / store.tsx, so no page changes.
export const LOCAL = import.meta.env.VITE_BACKEND === "local";

// the server: on this PC while testing; the same address the app was loaded from once the server hosts it
const BASE = (import.meta.env.VITE_SERVER as string | undefined) || (location.port === "5173" ? "http://127.0.0.1:8484" : "");
const TOKEN_KEY = "chittam.token";

let token = "";
try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch { /* private window */ }
const saveToken = (t: string) => { token = t; try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } };

export interface LocalUser { uid: string; email: string; displayName?: string; role?: string }
let current: LocalUser | null = null;
const authSubs = new Set<(u: LocalUser | null) => void>();
const emitAuth = () => authSubs.forEach((f) => f(current));

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(BASE + path, {
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
    .then((u) => { current = { uid: u.id, email: u.email, displayName: u.displayName, role: u.role }; emitAuth(); })
    .catch(() => { current = null; emitAuth(); });
  return () => { authSubs.delete(cb); };
}

export async function signIn(email: string, password: string) {
  const r = await api<{ token: string; user: { id: string; email: string; displayName: string; role: string } }>("/api/login", {
    method: "POST", body: JSON.stringify({ email, password, device: navigator.userAgent }),
  });
  saveToken(r.token);
  current = { uid: r.user.id, email: r.user.email, displayName: r.user.displayName, role: r.user.role };
  emitAuth();
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
  es = new EventSource(BASE + "/api/events?token=" + encodeURIComponent(token));
  es.onmessage = (e) => {
    try { const d = JSON.parse(e.data) as { collection?: string }; if (d.collection) subs.get(d.collection)?.forEach((f) => f()); }
    catch { /* ignore */ }
  };
  // after a dropped connection, reload everything once it's back
  es.onopen = () => subs.forEach((set) => set.forEach((f) => f()));
}
function closeEvents() { es?.close(); es = null; }
export function onChange(collection: string, f: () => void) {
  if (!subs.has(collection)) subs.set(collection, new Set());
  subs.get(collection)!.add(f);
  ensureEvents();
  return () => { subs.get(collection)?.delete(f); };
}

// ---------------------------------------------------------------- records
const META = ["createdAt", "createdBy", "updatedAt", "updatedBy", "version"];
const clean = <T,>(r: Record<string, unknown>) => { const o = { ...r }; META.forEach((k) => delete o[k]); return o as T; };

export function listenCollection<T>(name: string, cb: (items: T[], fromCache: boolean) => void, onError?: (e: Error) => void) {
  let alive = true;
  const load = () => api<Record<string, unknown>[]>("/api/" + name).then((rows) => { if (alive) cb(rows.map((r) => clean<T>(r)), false); }).catch((e) => onError?.(e));
  load();
  const off = onChange(name, load);
  return () => { alive = false; off(); };
}

export function listenDoc<T>(path: string, id: string, cb: (data: T | null) => void, onError?: (e: Error) => void) {
  let alive = true;
  const load = () => api<Record<string, unknown>>("/api/" + path + "/" + encodeURIComponent(id))
    .then((r) => { if (alive) cb(clean<T>(r)); })
    .catch((e) => { if (alive) { if (/not found/i.test((e as Error).message)) cb(null); else onError?.(e); } });
  load();
  const off = onChange(path, load);
  return () => { alive = false; off(); };
}

// each save carries a unique entry key, so a retry never saves twice
const entryKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export async function saveRecords(writes: { coll: string; id: string; data: Record<string, unknown> }[]) {
  for (const w of writes)
    await api("/api/" + w.coll + "/" + encodeURIComponent(w.id), { method: "PUT", body: JSON.stringify(clean(w.data)), headers: { "X-Entry-Key": entryKey() } });
}

export async function logEvent(action: string, details: Record<string, unknown>) {
  await api("/api/activity", { method: "POST", body: JSON.stringify({ collection: "app", action, name: details.name || details.customerName || "", details }) });
}

export async function saveMessage(id: string, msg: Record<string, unknown>) {
  await api("/api/messages/" + encodeURIComponent(id), { method: "PUT", body: JSON.stringify(msg), headers: { "X-Entry-Key": entryKey() } });
}

// dates as the pages expect them (they call .toDate())
const stamp = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? { toDate: () => new Date(v), seconds: Math.floor(Date.parse(v) / 1000) } : v ?? null);
export async function loadLatest<T>(coll: "activity" | "messages", count = 300) {
  const rows = await api<Record<string, unknown>[]>("/api/history?coll=" + coll + "&limit=" + count);
  return rows.map((r) => ({ ...r, at: stamp(r.at) }) as T);
}

// ---------------------------------------------------------------- Tally figures (from the mirror)
export const loadTally = <T,>(kind: "balances" | "vouchers" | "bills" | "stock") => api<T>("/api/tally/" + kind);
export const syncTallyNow = () => api<{ ok: boolean; changed?: number; error?: string }>("/api/tally/sync", { method: "POST" });
