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
import { CHITTAM_BUSINESS, inBusiness, pool } from "./db.ts";
import { businessesOf, chooseBusiness, login, logout, membership, sessionUser, type SessionUser } from "./auth.ts";
import { can, COLLECTION_MODULE, MODULE_LABEL, MODULES, permissions, usable, type Module, type Role } from "./roles.ts";
import * as tally from "./tallyapi.ts";
import { businessKeyRoutes, personKeyRoutes } from "./keys.ts";
import { runMirror } from "./mirror-tally.ts";
import { copyFromFirebase } from "./firebase-copy.ts";

const cfg = loadConfig();
// requests: each one says which business it works for (inBusiness), so a
// request can only ever see the business of the person signed in
const db = pool(cfg, null);
// the Tally mirror and the Firebase copy work for Chittam Enterprises only (for now)
const chittamDb = pool(cfg, CHITTAM_BUSINESS, "vahikosha-chittam-jobs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", accountant: "Accountant", staff: "Staff", outside_ca: "Outside CA" };

// which modules a business has on (a module with no row is on)
async function modulesOf(business: string): Promise<Record<Module, boolean>> {
  const r = await db.query("SELECT module, enabled FROM business_modules WHERE business_id = $1", [business]);
  const out = Object.fromEntries(MODULES.map((k) => [k, true])) as Record<Module, boolean>;
  for (const x of r.rows) out[x.module as Module] = x.enabled;
  return out;
}
const COLLECTIONS = new Set(["customers", "products", "transports", "orders", "services", "receipts", "messages", "settings"]);
const VERSION = "0.4.0";
const MIRROR_MINUTES = 15;
const COPY_MINUTES = 5;

// ---------------------------------------------------------------- live updates
// each open stream hears only the changes of its own business
const listeners = new Map<ServerResponse, string>();
async function startListening() {
  const client = new pg.Client({ ...cfg.db, application_name: "chittam-server-listen" });
  await client.connect();
  await client.query("LISTEN chittam_changes");
  client.on("notification", (n) => {
    let business = "";
    try { business = JSON.parse(n.payload || "{}").business || ""; } catch { /* not ours */ }
    for (const [res, b] of listeners) if (b === business) res.write("data: " + (n.payload || "{}") + "\n\n");
  });
  client.on("error", () => setTimeout(() => startListening().catch(() => {}), 3000));
}
const notify = (payload: object) => chittamDb.query("SELECT pg_notify('chittam_changes', $1)", [JSON.stringify(payload)]);

// ---------------------------------------------------------------- Tally mirror, every 15 minutes
let mirrorBusy = false, mirrorLast = "";
async function mirrorNow(reason: string) {
  if (mirrorBusy) return { ok: false, busy: true };
  mirrorBusy = true;
  const lines: string[] = [];
  try {
    const r = await runMirror(chittamDb, undefined, (s) => lines.push(s));
    mirrorLast = new Date().toISOString();
    if (r.changed) await notify({ business: CHITTAM_BUSINESS, collection: "tally" });
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
  const r = await copyFromFirebase(chittamDb, (s) => console.log(new Date().toLocaleTimeString("en-IN") + " Firebase copy (" + reason + "): " + s));
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
    if (!r) return send(res, 401, { error: "Wrong email or password." });
    return "error" in r ? send(res, 403, r) : send(res, 200, r);
  }

  // ---- everything else: signed in
  const token = bearer(req, url);
  const me: SessionUser | null = await sessionUser(db, token);
  if (!me) return send(res, 401, { error: "Please sign in." });
  const user = me.email;

  if (parts[1] === "me" && req.method === "GET") return send(res, 200, { ...me, businesses: me.isSupport ? [] : await businessesOf(db, me.id) });
  if (parts[1] === "logout" && req.method === "POST") { await logout(db, token); return send(res, 200, { ok: true }); }

  // ---- Chittam support: account status only, never business data
  if (me.isSupport) {
    if (parts[1] === "support" && parts[2] === "businesses" && req.method === "GET") {
      const r = await db.query(`SELECT b.id, b.name, b.status, b.created_at,
          (SELECT count(*)::int FROM members m WHERE m.business_id = b.id AND m.active) AS members
        FROM businesses b ORDER BY b.name`);
      return send(res, 200, r.rows.map((x) => ({ id: x.id, name: x.name, status: x.status, createdAt: x.created_at, members: x.members })));
    }
    return send(res, 403, { error: "Chittam support can't open business data." });
  }

  // ---- my own key pair (needs no business)
  if (await personKeyRoutes(req, res, parts, me.id, db, send, readBody)) return;

  // ---- which business
  if (parts[1] === "businesses" && req.method === "GET") return send(res, 200, await businessesOf(db, me.id));
  if (parts[1] === "business" && parts[2] === "select" && req.method === "POST") {
    const b = (await readBody(req)) as { businessId?: string };
    const m = UUID.test(String(b.businessId || "")) ? await chooseBusiness(db, token, me, String(b.businessId)) : null;
    return m ? send(res, 200, { ok: true, businessId: m.businessId, name: m.businessName, role: m.role }) : send(res, 403, { error: "You're not part of that business." });
  }
  if (!me.businessId) return send(res, 409, { error: "Choose a business first.", businesses: await businessesOf(db, me.id) });
  const m = await membership(db, me.id, me.businessId);
  if (!m || !usable(m)) return send(res, 403, { error: "You no longer have access to this business. Ask the owner." });
  const biz = m.businessId;
  const run = <T>(fn: (c: pg.PoolClient) => Promise<T>) => inBusiness(db, biz, fn);
  const refuse = (what: string) => send(res, 403, { error: "Your role (" + ROLE_LABEL[m.role] + ") can't " + what + "." });
  const chittamOnly = () => send(res, 400, { error: "This works only for Chittam Enterprises for now. Other businesses get the Tally connector in a later update." });
  const modules = await modulesOf(biz);

  if (await businessKeyRoutes({ req, res, parts, userId: me.id, email: user, m, db, run, send, readBody, refuse })) return;

  if (parts[1] === "business" && !parts[2] && req.method === "GET") {
    return send(res, 200, { id: biz, name: m.businessName, role: m.role, permissions: permissions(m), accountantCanApprove: m.accountantCanApprove, modules });
  }
  if (parts[1] === "business" && parts[2] === "modules" && req.method === "PUT") {
    if (!can(m, "business.manage")) return refuse("switch modules on or off");
    const b = (await readBody(req)) as Record<string, unknown>;
    const changes = MODULES.filter((k) => typeof b[k] === "boolean" && b[k] !== modules[k]);
    for (const k of changes) {
      await db.query(`INSERT INTO business_modules (business_id, module, enabled, changed_by) VALUES ($1, $2, $3, $4)
        ON CONFLICT (business_id, module) DO UPDATE SET enabled = EXCLUDED.enabled, changed_by = EXCLUDED.changed_by, changed_at = now()`, [biz, k, b[k], user]);
      await run((c) => c.query("INSERT INTO activity (by_user, collection, record_id, action, name) VALUES ($1, 'business', $2, $3, $4)",
        [user, k, b[k] ? "module-on" : "module-off", MODULE_LABEL[k]]));
    }
    return send(res, 200, { modules: await modulesOf(biz) });
  }
  if (parts[1] === "business" && parts[2] === "approval" && req.method === "PUT") {
    if (!can(m, "business.manage")) return refuse("change who approves entries");
    const b = (await readBody(req)) as { accountantCanApprove?: unknown };
    if (typeof b.accountantCanApprove !== "boolean") return send(res, 400, { error: "accountantCanApprove must be true or false" });
    await db.query("UPDATE businesses SET accountant_can_approve = $2 WHERE id = $1", [biz, b.accountantCanApprove]);
    await run((c) => c.query("INSERT INTO activity (by_user, collection, action, name) VALUES ($1, 'business', $2, $3)",
      [user, b.accountantCanApprove ? "accountant-may-approve" : "only-owner-approves", m.businessName]));
    return send(res, 200, { accountantCanApprove: b.accountantCanApprove });
  }
  if (parts[1] === "business" && parts[2] === "members" && req.method === "GET") {
    if (!can(m, "team.manage")) return refuse("see the team");
    const r = await db.query(`SELECT u.email, u.display_name, m.role, m.active, to_char(m.access_from, 'YYYY-MM-DD') AS access_from, to_char(m.access_to, 'YYYY-MM-DD') AS access_to
      FROM members m JOIN app_users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY m.active DESC, u.email`, [biz]);
    return send(res, 200, r.rows.map((x) => ({ email: x.email, name: x.display_name, role: x.role, active: x.active, accessFrom: x.access_from, accessTo: x.access_to })));
  }

  if (parts[1] === "events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.set(res, biz);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  if (parts[1] === "tally" && req.method === "GET") {
    if (!can(m, "tally.read")) return refuse("see Tally figures");
    const what = parts[2];
    // the Windows app's uploads copied from Firebase (all companies) when there are any; else the mirror
    if (what === "balances") return send(res, 200, await run(async (c) => (await tally.fromCopy(c, "balances")) || (await tally.balances(c))));
    if (what === "vouchers") return send(res, 200, await run(async (c) => (await tally.fromCopy(c, "tallyVouchers")) || (await tally.vouchers(c))));
    if (what === "bills") return send(res, 200, await run(async (c) => (await tally.fromCopy(c, "tallyBills")) || (await tally.bills(c))));
    if (what === "stock") return send(res, 200, await run(async (c) => (await tally.fromCopy(c, "tallyStock")) || (await tally.stock(c))));
    return send(res, 404, { error: "Unknown Tally data" });
  }
  if (parts[1] === "tally" && parts[2] === "sync" && req.method === "POST") {
    if (!can(m, "tally.sync")) return refuse("start a Tally sync");
    return biz === CHITTAM_BUSINESS ? send(res, 200, await mirrorNow("asked by " + user)) : chittamOnly();
  }
  if (parts[1] === "firebase" && parts[2] === "copy" && req.method === "POST") {
    if (!can(m, "tally.sync")) return refuse("copy from Firebase");
    return biz === CHITTAM_BUSINESS ? send(res, 200, await copyNow("asked by " + user)) : chittamOnly();
  }

  if (parts[1] === "history" && req.method === "GET") {
    const n = Math.min(Number(url.searchParams.get("limit")) || 300, 2000);
    if (url.searchParams.get("coll") === "messages") {
      if (!can(m, "records.read")) return refuse("see messages");
      const r = await run((c) => c.query("SELECT id, data, created_at FROM messages ORDER BY created_at DESC LIMIT $1", [n]));
      return send(res, 200, r.rows.map((x) => ({ ...x.data, id: x.id, at: x.data.at || x.created_at })));
    }
    if (!can(m, "history.read")) return refuse("see the history");
    const r = await run((c) => c.query("SELECT id, at, by_user, collection, record_id, action, name, details, before, after FROM activity ORDER BY at DESC, id DESC LIMIT $1", [n]));
    return send(res, 200, r.rows.map((x) => ({ id: String(x.id), at: x.at, by: x.by_user, collection: x.collection, docId: x.record_id || undefined, action: x.action, name: x.name, details: x.details, before: x.before, after: x.after })));
  }

  // one-time move from Firebase: saved as a backup file (import-firebase.ts imports it)
  if (parts[1] === "import" && parts[2] === "firebase-snapshot" && req.method === "POST") {
    if (!can(m, "business.manage")) return refuse("import from Firebase");
    if (biz !== CHITTAM_BUSINESS) return chittamOnly();
    const snap = (await readBody(req, 300e6)) as { exportedAt?: string; by?: string; collections?: Record<string, unknown[]> };
    if (!snap.collections || typeof snap.collections !== "object") return send(res, 400, { error: "No collections in the export" });
    const dir = join(cfg.storage, "..", "backups", "firebase");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "firebase-export-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json");
    writeFileSync(file, JSON.stringify(snap));
    const counts = Object.fromEntries(Object.entries(snap.collections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    await run((c) => c.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'app', 'firebase-export-saved', $2, $3)", [user, file, { file, counts, exportedAt: snap.exportedAt || "" }]));
    return send(res, 201, { ok: true, file, counts });
  }

  if (parts[1] === "activity" && req.method === "POST") {
    if (!can(m, "records.write")) return refuse("add history entries");
    const b = (await readBody(req)) as Record<string, unknown>;
    if (!b.action) return send(res, 400, { error: "action is required" });
    // a phone resending an entry from its outbox: saved once
    const entryKey = String(req.headers["x-entry-key"] || "");
    await run(async (c) => {
      if (entryKey && (await c.query("SELECT 1 FROM submissions WHERE entry_key = $1", [entryKey])).rowCount) return;
      await c.query("INSERT INTO activity (by_user, collection, record_id, action, name, details) VALUES ($1, $2, $3, $4, $5, $6)",
        [user, String(b.collection || "app"), b.recordId ? String(b.recordId) : null, String(b.action), String(b.name || ""), b.details ?? null]);
      if (entryKey) await c.query("INSERT INTO submissions (entry_key, by_user, collection, record_id, result) VALUES ($1, $2, 'activity', '', $3)", [entryKey, user, { ok: true }]);
    });
    return send(res, 201, { ok: true });
  }

  const coll = parts[1];
  if (!COLLECTIONS.has(coll)) return send(res, 404, { error: "Unknown collection: " + coll });
  const mod = COLLECTION_MODULE[coll];
  if (mod && !modules[mod]) return send(res, 403, { error: "The " + MODULE_LABEL[mod] + " module is switched off for this business. The owner can switch it on in Settings." });
  const id = parts[2] ? decodeURIComponent(parts[2]) : "";

  if (req.method === "GET" && !id) {
    if (!can(m, "records.read")) return refuse("see records");
    const r = await run((c) => c.query(`SELECT id, version, updated_at, data FROM ${coll} ORDER BY updated_at DESC`));
    return send(res, 200, r.rows.map(row));
  }
  if (req.method === "GET" && id) {
    if (!can(m, "records.read")) return refuse("see records");
    const r = await run((c) => c.query(`SELECT id, version, updated_at, data FROM ${coll} WHERE id = $1`, [id]));
    return r.rowCount ? send(res, 200, row(r.rows[0])) : send(res, 404, { error: "Not found" });
  }
  if (req.method === "PUT" && id) {
    if (!can(m, "records.write")) return refuse("change records");
    // settings hold business-wide choices: owner only
    if (coll === "settings" && !can(m, "business.manage")) return refuse("change settings");
    const body = (await readBody(req)) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return send(res, 400, { error: "Body must be an object" });
    const { id: _i, version: _v, updatedAt: _u, ...data } = body;
    const entryKey = String(req.headers["x-entry-key"] || "");
    const ifMatch = req.headers["if-match"] ? Number(req.headers["if-match"]) : null;
    const result = await run(async (c) => {
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
      await c.query("SELECT pg_notify('chittam_changes', $1)", [JSON.stringify({ business: biz, collection: coll, id, version: out.version })]);
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
