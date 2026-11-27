// Keeps PostgreSQL an up-to-date copy of Firebase while Firebase is still the
// live database. Each run reads only what changed since the last run
// (updatedAt / at), so it costs a handful of Firebase reads, opens encrypted
// records with the key the Windows app keeps on this PC, and saves:
//   - records (customers … settings) into their tables (unchanged ones skipped)
//   - saved messages and history entries that aren't there yet
//   - the Tally figures (balances, transactions, open bills, stock) of every
//     company into fb_tally, exactly as the Windows app uploads them
// One History entry per run that copied anything. Nothing is ever deleted.
//   node src/firebase-copy.ts          run once (also started by the server every few minutes)
import { createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import type pg from "pg";
import { readWinSecrets, type WinSecrets } from "./winsecrets.ts";

const RECORDS = ["customers", "products", "transports", "orders", "services", "receipts", "settings"];
const TALLY = ["balances", "tallyVouchers", "tallyBills", "tallyStock"];
const LOGS = ["messages", "activity"];

/* ---------------- Firestore REST ---------------- */

type Typed = Record<string, unknown>;
function plain(v: unknown): unknown {
  const t = v as Typed;
  if (!t || typeof t !== "object") return null;
  if ("stringValue" in t) return t.stringValue;
  if ("integerValue" in t) return Number(t.integerValue);
  if ("doubleValue" in t) return Number(t.doubleValue);
  if ("booleanValue" in t) return t.booleanValue;
  if ("timestampValue" in t) return t.timestampValue;
  if ("nullValue" in t) return null;
  if ("mapValue" in t) return Object.fromEntries(Object.entries(((t.mapValue as Typed).fields as Typed) || {}).map(([k, x]) => [k, plain(x)]));
  if ("arrayValue" in t) return (((t.arrayValue as Typed).values as unknown[]) || []).map(plain);
  return null;
}

function openSealed(key: Buffer, sealed: string): Record<string, unknown> {
  const all = Buffer.from(sealed, "base64");
  if (all.length < 64) throw new Error("Damaged encrypted record");
  const body = all.subarray(0, all.length - 32), mac = all.subarray(all.length - 32);
  const want = createHmac("sha256", key.subarray(32, 64)).update(body).digest();
  if (!timingSafeEqual(want, mac)) throw new Error("Encrypted with a different passphrase");
  const d = createDecipheriv("aes-256-cbc", key.subarray(0, 32), body.subarray(0, 16));
  const z = Buffer.concat([d.update(body.subarray(16)), d.final()]);
  return JSON.parse(inflateRawSync(z).toString("utf8"));
}

class Firestore {
  token = "";
  s: WinSecrets;
  constructor(s: WinSecrets) { this.s = s; }
  get base() { return "https://firestore.googleapis.com/v1/projects/" + this.s.projectId + "/databases/(default)/documents"; }
  async signIn() {
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + this.s.apiKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.s.email, password: this.s.password, returnSecureToken: true }),
    });
    const j = (await r.json()) as { idToken?: string; error?: { message?: string } };
    if (!j.idToken) throw new Error("Firebase sign-in failed: " + (j.error?.message || r.status));
    this.token = j.idToken;
  }
  async getDoc(path: string) {
    const r = await fetch(this.base + "/" + path, { headers: { Authorization: "Bearer " + this.token } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("Firebase read " + path + ": " + r.status);
    const j = (await r.json()) as { fields?: Typed };
    return Object.fromEntries(Object.entries(j.fields || {}).map(([k, v]) => [k, plain(v)]));
  }
  // documents of one collection changed after `since` (all of them when since is null)
  async changed(coll: string, field: string, since: string | null) {
    const query: Record<string, unknown> = { from: [{ collectionId: coll }] };
    if (since) query.where = { fieldFilter: { field: { fieldPath: field }, op: "GREATER_THAN", value: { timestampValue: since } } };
    const r = await fetch(this.base + ":runQuery", {
      method: "POST", headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery: query }),
    });
    if (!r.ok) throw new Error("Firebase query " + coll + ": " + r.status + " " + (await r.text()).slice(0, 200));
    const rows = (await r.json()) as { document?: { name: string; fields?: Typed } }[];
    return rows.filter((x) => x.document).map((x) => ({
      id: x.document!.name.slice(x.document!.name.lastIndexOf("/") + 1),
      data: Object.fromEntries(Object.entries(x.document!.fields || {}).map(([k, v]) => [k, plain(v)])) as Record<string, unknown>,
    }));
  }
}

/* ---------------- the copy ---------------- */

export interface CopyResult { ok: boolean; copied: Record<string, number>; error?: string }
let busy = false;

export async function copyFromFirebase(db: pg.Pool, log: (s: string) => void = () => {}): Promise<CopyResult> {
  if (busy) return { ok: false, copied: {}, error: "already running" };
  busy = true;
  const copied: Record<string, number> = {};
  try {
    const s = readWinSecrets();
    const fs = new Firestore(s);
    await fs.signIn();
    // is Firebase encrypted, and does this PC have the right key?
    const cfg = await fs.getDoc("settings/crypto");
    const encOn = !!cfg?.on;
    if (encOn && (!s.key || s.salt !== cfg!.salt)) throw new Error("Firebase is encrypted: enter the passphrase in the Windows app (Tally Sync → Passphrase…) first.");
    const open = (d: Record<string, unknown>) => {
      if (typeof d.enc !== "string") return d;
      const { enc, encV: _v, ...rest } = d;
      return { ...rest, ...openSealed(s.key!, enc) };
    };
    const state = Object.fromEntries((await db.query("SELECT coll, last_seen FROM fb_copy_state")).rows.map((r) => [r.coll, r.last_seen ? new Date(r.last_seen).toISOString() : null]));
    const newest = (docs: { data: Record<string, unknown> }[], field: string, prev: string | null) =>
      docs.map((d) => d.data[field]).filter((x): x is string => typeof x === "string").reduce((m, x) => (x > m ? x : m), prev || "");

    // ---- records
    for (const coll of RECORDS) {
      const docs = await fs.changed(coll, "updatedAt", state[coll] ?? null);
      let n = 0;
      for (const doc of docs) {
        if (coll === "settings" && doc.id !== "main") continue;
        const full = open(doc.data);
        const { createdAt, createdBy: _cb, updatedAt, updatedBy, ...data } = full as Record<string, unknown>;
        const pgId = coll === "settings" ? "main" : doc.id;
        const ex = await db.query(`SELECT data = $2::jsonb AS same FROM ${coll} WHERE id = $1`, [pgId, data]);
        if (ex.rowCount && ex.rows[0].same) continue;
        if (ex.rowCount) await db.query(`UPDATE ${coll} SET data = $2, updated_by = $3 WHERE id = $1`, [pgId, data, String(updatedBy || "firebase")]);
        else await db.query(`INSERT INTO ${coll} (id, data, created_at, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)`,
          [pgId, data, (createdAt as string) || (updatedAt as string) || new Date().toISOString(), (updatedAt as string) || new Date().toISOString(), String(updatedBy || "firebase")]);
        await db.query("SELECT pg_notify('chittam_changes', ($1::jsonb || jsonb_build_object('business', current_business()))::text)", [JSON.stringify({ collection: coll, id: pgId })]);
        n++;
      }
      await saveState(db, coll, newest(docs, "updatedAt", state[coll] ?? null), n);
      if (n) copied[coll] = n;
    }

    // ---- saved messages and history (only added, never changed)
    for (const coll of LOGS) {
      const docs = await fs.changed(coll, "at", state[coll] ?? null);
      let n = 0;
      for (const doc of docs) {
        const a = open(doc.data);
        if (coll === "messages") {
          const r = await db.query("INSERT INTO messages (id, data, created_at, updated_by) VALUES ($1, $2, $3, $4) ON CONFLICT (business_id, id) DO NOTHING",
            [doc.id, a, (a.at as string) || new Date().toISOString(), String(a.by || "")]);
          n += r.rowCount || 0;
        } else {
          const seen = await db.query("SELECT 1 FROM activity WHERE details->>'firestoreId' = $1 LIMIT 1", [doc.id]);
          if (seen.rowCount) continue;
          await db.query(`INSERT INTO activity (at, by_user, collection, record_id, action, name, details, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [(a.at as string) || new Date().toISOString(), String(a.by || ""), String(a.collection || "app"), a.docId ? String(a.docId) : null, String(a.action || "?"),
             String(a.name || ""), { ...((a.details as object) || {}), firestoreId: doc.id, importedFrom: "firebase" }, a.before ?? null, a.after ?? null]);
          n++;
        }
      }
      await saveState(db, coll, newest(docs, "at", state[coll] ?? null), n);
      if (n) copied[coll] = n;
    }

    // ---- Tally figures of every company, as uploaded by the Windows app
    for (const kind of TALLY) {
      const docs = await fs.changed(kind, "at", state[kind] ?? null);
      let n = 0;
      for (const doc of docs) {
        const { at: _a, by: _b, ...data } = open(doc.data);
        const r = await db.query(`INSERT INTO fb_tally (kind, key, data) VALUES ($1, $2, $3)
          ON CONFLICT (business_id, kind, key) DO UPDATE SET data = EXCLUDED.data, copied_at = now() WHERE fb_tally.data IS DISTINCT FROM EXCLUDED.data`, [kind, doc.id, data]);
        n += r.rowCount || 0;
      }
      await saveState(db, kind, newest(docs, "at", state[kind] ?? null), n);
      if (n) copied[kind] = n;
    }
    if (copied.balances || copied.tallyVouchers || copied.tallyBills || copied.tallyStock)
      await db.query("SELECT pg_notify('chittam_changes', ($1::jsonb || jsonb_build_object('business', current_business()))::text)", [JSON.stringify({ collection: "tally" })]);

    const total = Object.values(copied).reduce((t, x) => t + x, 0);
    if (total) await db.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ('server', 'app', 'firebase-copy', 'Copied from Firebase', $1)", [{ copied, encrypted: encOn }]);
    log(total ? "copied " + Object.entries(copied).map(([k, v]) => v + " " + k).join(", ") : "no change");
    return { ok: true, copied };
  } catch (e) {
    log("failed: " + (e as Error).message);
    return { ok: false, copied, error: (e as Error).message };
  } finally {
    busy = false;
  }
}

async function saveState(db: pg.Pool, coll: string, lastSeen: string, n: number) {
  await db.query(`INSERT INTO fb_copy_state (coll, last_seen, last_run, copied) VALUES ($1, NULLIF($2, '')::timestamptz, now(), $3)
    ON CONFLICT (business_id, coll) DO UPDATE SET last_seen = COALESCE(NULLIF($2, '')::timestamptz, fb_copy_state.last_seen), last_run = now(), copied = fb_copy_state.copied + $3`, [coll, lastSeen, n]);
}

// run once from the command line
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("src/firebase-copy.ts")) {
  const { loadConfig } = await import("./config.ts");
  const { pool, CHITTAM_BUSINESS } = await import("./db.ts");
  const p = pool(loadConfig(), CHITTAM_BUSINESS);
  const r = await copyFromFirebase(p, (s) => console.log("Firebase copy: " + s));
  await p.end();
  process.exit(r.ok ? 0 : 1);
}
