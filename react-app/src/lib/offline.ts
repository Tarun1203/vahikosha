// The phone's own copy of the data, for working with no connection to the
// office PC (Android app and the local-server app):
//   - every list / figure read from the server is kept here, and shown when
//     the server can't be reached;
//   - every save made while offline waits in the outbox (with its unique entry
//     key) and is sent, in order, as soon as the server answers again — the
//     server never saves the same entry twice.
// Stored in IndexedDB on the device; nothing here is ever sent anywhere else.

const DB = "chittam-offline", CACHE = "cache", OUTBOX = "outbox";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(CACHE);
      r.result.createObjectStore(OUTBOX, { keyPath: "seq", autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function run<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = f(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/* ---------------- the saved copy ---------------- */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try { return await run<T | undefined>(CACHE, "readonly", (s) => s.get(key)); } catch { return undefined; }
}
export async function cachePut(key: string, value: unknown) {
  try { await run(CACHE, "readwrite", (s) => s.put(value, key)); } catch { /* storage full or blocked: still works online */ }
}

/* ---------------- the outbox ---------------- */
export interface Pending { seq?: number; kind: "record" | "event" | "message"; coll: string; id: string; data: Record<string, unknown>; entryKey: string; at: string }
export const outboxAll = () => run<Pending[]>(OUTBOX, "readonly", (s) => s.getAll()).catch(() => [] as Pending[]);
export const outboxAdd = (p: Pending) => run(OUTBOX, "readwrite", (s) => s.add(p));
export const outboxDone = (seq: number) => run(OUTBOX, "readwrite", (s) => s.delete(seq));

const subs = new Set<(n: number) => void>();
export function onOutbox(f: (n: number) => void) { subs.add(f); outboxAll().then((l) => f(l.length)); return () => { subs.delete(f); }; }
export async function outboxChanged() { const n = (await outboxAll()).length; subs.forEach((f) => f(n)); }

// a failed fetch (no route to the office PC) — not an answer from the server
export const isOffline = (e: unknown) => e instanceof TypeError || /Failed to fetch|NetworkError|Load failed|network/i.test(String((e as Error)?.message || ""));
