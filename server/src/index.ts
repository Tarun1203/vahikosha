// Chittam local server. The web app, the Windows app and (later) the phones
// read and write the one PostgreSQL database through it — never directly.
//
//   GET  /api/health                     open: is the database reachable?
//   POST /api/login {email, password}    → { token, user }
//   POST /api/logout · GET /api/me
//   GET  /api/:collection                all records  [{ id, version, updatedAt, ...data }]
//   GET  /api/:collection/:id            one record
//   PUT  /api/:collection/:id            save (create or update), logged in history
//        X-Entry-Key: no-duplicate key from a phone · If-Match: <version>
//   POST /api/activity                   add a history entry
//   GET  /api/history?coll=activity|messages&limit=300   newest first
//   GET  /api/tally/balances|vouchers|bills|stock         figures from the Tally mirror
//   POST /api/tally/sync                 read Tally now
//   POST /api/firebase/copy              copy Firebase changes now (also every 5 minutes)
//   GET  /api/events?token=…             live updates (Server-Sent Events)
//
// Every route except /api/health needs a signed-in session (Authorization: Bearer <token>).
// No deletes: there is no DELETE route, and the database refuses them anyway.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "./config.ts";
import { pool, tx } from "./db.ts";
import { login, logout, sessionUser, type SessionUser } from "./auth.ts";
import * as tally from "./tallyapi.ts";
import { runMirror } from "./mirror-tally.ts";
import { copyFromFirebase } from "./firebase-copy.ts";

const cfg = loadConfig();
const db = pool(cfg);
const COLLECTIONS = new Set(["customers", "products", "transports", "orders", "services", "receipts", "messages", "settings"]);
const VERSION = "0.2.0";
const MIRROR_MINUTES = 15;
const COPY_MINUTES = 5;

// ---------------------------------------------------------------- live updates
const listeners = new Set<ServerResponse>();
async function startListening() {
  const client = new pg.Client({ ...cfg.db, application_name: "chittam-server-listen" });
  await client.connect();
  await client.query("LISTEN chittam_changes");
  client.on("notification", (n) => { for (const res of listeners) res.write("data: " + (n.payload || "{}") + "\n\n"); });
  client.on("error", () => setTimeout(() => startListening().catch(() => {}), 3000));
}
const notify = (payload: object) => db.query("SELECT pg_notify('chittam_changes', $1)", [JSON.stringify(payload)]);

// ---------------------------------------------------------------- Tally mirror, every 15 minutes
let mirrorBusy = false, mirrorLast = "";
async function mirrorNow(reason: string) {
  if (mirrorBusy) return { ok: false, busy: true };
  mirrorBusy = true;
  const lines: string[] = [];
  try {
    const r = await runMirror(db, undefined, (s) => lines.push(s));
    mirrorLast = new Date().toISOString();
    if (r.changed) await notify({ collection: "tally" });
    console.log(new Date().toLocaleTimeString("en-IN") + " Tally mirror (" + reason + "): " + (r.changed ? r.changed + " voucher change(s)" : "no change") + (r.bad ? ", " + r.bad + " to check" : ""));
    return { ok: r.bad === 0, changed: r.changed, log: lines };
  } catch (e) {
    console.log(new Date().toLocaleTimeString("en-IN") + " Tally mirror failed: " + (e as Error).message);
    return { ok: false, error: (e as Error).message, log: lines };
  } finally { mirrorBusy = false; }
}

// ---------------------------------------------------------------- Firebase copy, every 5 minutes
// (while Firebase is still the live database; CHITTAM_FIREBASE_COPY=off stops it)
let copyLast = "", copyError = "";
async function copyNow(reason: string) {
  const r = await copyFromFirebase(db, (s) => console.log(new Date().toLocaleTimeString("en-IN") + " Firebase copy (" + reason + "): " + s));
  if (r.ok) { copyLast = new Date().toISOString(); copyError = ""; } else if (r.error !== "already running") copyError = r.error || "";
  return r;
}

// ---------------------------------------------------------------- helpers
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
async function readBody(req: IncomingMessage, max = 5e6): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const ch of req) { size += ch.length; if (size > max) throw Object.assign(new Error("Body too large"), { status: 413 }); chunks.push(ch); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Body is not valid JSON"), { status: 400 }); }
}
const row = (r: { id: string; version: number; updated_at: Date; data: Record<string, unknown> }) => ({ ...r.data, id: r.id, version: r.version, updatedAt: r.updated_at });
const bearer = (req: IncomingMessage, url: URL) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";

// ---------------------------------------------------------------- routes
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://local");
  const parts = url.pathname.split("/").filter(Boolean);   // ["api", coll, id]
  if (parts[0] !== "api") return send(res, 404, { error: "Not found" });

  // ---- open routes
  if (parts[1] === "health" && req.method === "GET") {
    const m = await db.query("SELECT name FROM schema_migrations ORDER BY name");
    return send(res, 200, { ok: true, server: VERSION, time: new Date().toISOString(), migrations: m.rows.map((x) => x.name), tallyMirror: mirrorLast, firebaseCopy: copyLast, firebaseCopyError: copyError });
  }
  if (parts[1] === "login" && req.method === "POST") {
    const b = (await readBody(req)) as { email?: string; password?: string; device?: string };
    if (!b.email || !b.password) return send(res, 400, { error: "Enter your email and password." });
    const r = await login(db, b.email, b.password, b.device || String(req.headers["user-agent"] || ""));
    return r ? send(res, 200, r) : send(res, 401, { error: "Wrong email or password." });
  }

  // ---- everything else: signed in
  const token = bearer(req, url);
  const me: SessionUser | null = await sessionUser(db, token);
  if (!me) return send(res, 401, { error: "Please sign in." });
  const user = me.email;

  if (parts[1] === "me" && req.method === "GET") return send(res, 200, me);
  if (parts[1] === "logout" && req.method === "POST") { await logout(db, token); return send(res, 200, { ok: true }); }

  if (parts[1] === "events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  if (parts[1] === "tally" && req.method === "GET") {
    const what = parts[2];
    // the Windows app's uploads copied from Firebase (all companies) when there are any; else the mirror
    if (what === "balances") return send(res, 200, (await tally.fromCopy(db, "balances")) || (await tally.balances(db)));
    if (what === "vouchers") return send(res, 200, (await tally.fromCopy(db, "tallyVouchers")) || (await tally.vouchers(db)));
    if (what === "bills") return send(res, 200, (await tally.fromCopy(db, "tallyBills")) || (await tally.bills(db)));
    if (what === "stock") return send(res, 200, (await tally.fromCopy(db, "tallyStock")) || (await tally.stock(db)));
    return send(res, 404, { error: "Unknown Tally data" });
  }
  if (parts[1] === "tally" && parts[2] === "sync" && req.method === "POST") return send(res, 200, await mirrorNow("asked by " + user));
  if (parts[1] === "firebase" && parts[2] === "copy" && req.method === "POST") return send(res, 200, await copyNow("asked by " + user));

  if (parts[1] === "history" && req.method === "GET") {
    const n = Math.min(Number(url.searchParams.get("limit")) || 300, 2000);
    if (url.searchParams.get("coll") === "messages") {
      const r = await db.query("SELECT id, data, created_at FROM messages ORDER BY created_at DESC LIMIT $1", [n]);
      return send(res, 200, r.rows.map((x) => ({ ...x.data, id: x.id, at: x.data.at || x.created_at })));
    }
    const r = await db.query("SELECT id, at, by_user, collection, record_id, action, name, details, before, after FROM activity ORDER BY at DESC, id DESC LIMIT $1", [n]);
    return send(res, 200, r.rows.map((x) => ({ id: String(x.id), at: x.at, by: x.by_user, collection: x.collection, docId: x.record_id || undefined, action: x.action, name: x.name, details: x.details, before: x.before, after: x.after })));
  }

  // one-time move from Firebase: saved as a backup file (import-firebase.ts imports it)
  if (parts[1] === "import" && parts[2] === "firebase-snapshot" && req.method === "POST") {
    const snap = (await readBody(req, 300e6)) as { exportedAt?: string; by?: string; collections?: Record<string, unknown[]> };
    if (!snap.collections || typeof snap.collections !== "object") return send(res, 400, { error: "No collections in the export" });
    const dir = join(cfg.storage, "..", "backups", "firebase");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "firebase-export-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json");
    writeFileSync(file, JSON.stringify(snap));
    const counts = Object.fromEntries(Object.entries(snap.collections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    await db.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'app', 'firebase-export-saved', $2, $3)", [user, file, { file, counts, exportedAt: snap.exportedAt || "" }]);
    return send(res, 201, { ok: true, file, counts });
  }

  if (parts[1] === "activity" && req.method === "POST") {
    const b = (await readBody(req)) as Record<string, unknown>;
    if (!b.action) return send(res, 400, { error: "action is required" });
    // a phone resending an entry from its outbox: saved once
    const entryKey = String(req.headers["x-entry-key"] || "");
    await tx(db, async (c) => {
      if (entryKey && (await c.query("SELECT 1 FROM submissions WHERE entry_key = $1", [entryKey])).rowCount) return;
      await c.query("INSERT INTO activity (by_user, collection, record_id, action, name, details) VALUES ($1, $2, $3, $4, $5, $6)",
        [user, String(b.collection || "app"), b.recordId ? String(b.recordId) : null, String(b.action), String(b.name || ""), b.details ?? null]);
      if (entryKey) await c.query("INSERT INTO submissions (entry_key, by_user, collection, record_id, result) VALUES ($1, $2, 'activity', '', $3)", [entryKey, user, { ok: true }]);
    });
    return send(res, 201, { ok: true });
  }

  const coll = parts[1];
  if (!COLLECTIONS.has(coll)) return send(res, 404, { error: "Unknown collection: " + coll });
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";

  if (req.method === "GET" && !id) {
    const r = await db.query(`SELECT id, version, updated_at, data FROM ${coll} ORDER BY updated_at DESC`);
    return send(res, 200, r.rows.map(row));
  }
  if (req.method === "GET" && id) {
    const r = await db.query(`SELECT id, version, updated_at, data FROM ${coll} WHERE id = $1`, [id]);
    return r.rowCount ? send(res, 200, row(r.rows[0])) : send(res, 404, { error: "Not found" });
  }
  if (req.method === "PUT" && id) {
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return send(res, 400, { error: "Body must be an object" });
    const { id: _i, version: _v, updatedAt: _u, ...data } = body;
    const entryKey = String(req.headers["x-entry-key"] || "");
    const ifMatch = req.headers["if-match"] ? Number(req.headers["if-match"]) : null;
    const result = await tx(db, async (c) => {
      // a phone resending the same entry gets the first answer back; nothing is saved twice
      if (entryKey) {
        const seen = await c.query("SELECT result FROM submissions WHERE entry_key = $1", [entryKey]);
        if (seen.rowCount) return { status: 200, body: { ...seen.rows[0].result, duplicate: true } };
      }
      const before = await c.query(`SELECT version, data FROM ${coll} WHERE id = $1 FOR UPDATE`, [id]);
      if (ifMatch !== null && before.rowCount && before.rows[0].version !== ifMatch)
        return { status: 409, body: { error: "Someone else changed this record. Reload and try again.", version: before.rows[0].version } };
      if (before.rowCount && JSON.stringify(before.rows[0].data) === JSON.stringify(data))
        return { status: 200, body: { id, unchanged: true } };
      const saved = before.rowCount
        ? await c.query(`UPDATE ${coll} SET data = $2, updated_by = $3 WHERE id = $1 RETURNING id, version, updated_at, data`, [id, data, user])
        : await c.query(`INSERT INTO ${coll} (id, data, updated_by) VALUES ($1, $2, $3) RETURNING id, version, updated_at, data`, [id, data, user]);
      const d = data as Record<string, unknown>;
      const no = d.orderNo || d.jobNo;
      const name = String(d.name || d.businessName || (no ? no + (d.customerName ? " — " + d.customerName : "") : "") || d.customerName || "");
      await c.query("INSERT INTO activity (by_user, collection, record_id, action, name, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [user, coll, id, before.rowCount ? "update" : "create", name, before.rows[0]?.data ?? null, data]);
      const out = row(saved.rows[0]);
      if (entryKey) await c.query("INSERT INTO submissions (entry_key, by_user, collection, record_id, result) VALUES ($1, $2, $3, $4, $5)", [entryKey, user, coll, id, out]);
      await c.query("SELECT pg_notify('chittam_changes', $1)", [JSON.stringify({ collection: coll, id, version: out.version })]);
      return { status: before.rowCount ? 200 : 201, body: out };
    });
    return send(res, result.status, result.body);
  }
  return send(res, 405, { error: "Not allowed" });
}

// the local copy of the app (npm run dev on this PC) may call the server from the browser
// and the Android app (its pages are served inside the app as http://localhost)
const LOCAL_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost"]);

const server = createServer((req, res) => {
  const origin = String(req.headers.origin || "");
  if (LOCAL_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Entry-Key, If-Match");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST");
    res.setHeader("Vary", "Origin");
  } else if (origin) {
    return send(res, 403, { error: "Not allowed from " + origin });
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  handle(req, res).catch((e) => {
    const status = (e as { status?: number }).status || 500;
    send(res, status, { error: (e as Error).message });
  });
});

await startListening();
server.listen(cfg.http.port, cfg.http.host, () => console.log(`Chittam server ${VERSION} on http://${cfg.http.host}:${cfg.http.port}`));
// reading Tally on a timer is switched on deliberately (CHITTAM_MIRROR=on), never by default
if (process.env.CHITTAM_MIRROR === "on") {
  setTimeout(() => mirrorNow("start"), 5000);
  setInterval(() => mirrorNow("every " + MIRROR_MINUTES + " min"), MIRROR_MINUTES * 60e3);
  console.log("Tally mirror: every " + MIRROR_MINUTES + " minutes");
} else console.log("Tally mirror: off (set CHITTAM_MIRROR=on to read Tally every " + MIRROR_MINUTES + " minutes)");
if (process.env.CHITTAM_FIREBASE_COPY !== "off") {
  setTimeout(() => copyNow("start"), 3000);
  setInterval(() => copyNow("every " + COPY_MINUTES + " min"), COPY_MINUTES * 60e3);
  console.log("Firebase copy: every " + COPY_MINUTES + " minutes");
}
