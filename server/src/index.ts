// Chittam local server. The web app, the Windows app and (later) the phones
// read and write the one PostgreSQL database through it — never directly.
//
//   GET  /api/health               database reachable? which migrations?
//   GET  /api/:collection          all records  [{ id, version, updatedAt, ...data }]
//   GET  /api/:collection/:id      one record
//   PUT  /api/:collection/:id      save (create or update); body = the record
//        headers: X-User, X-Entry-Key (no-duplicate key from the phone),
//                 If-Match: <version> (refuse if someone saved in between)
//   POST /api/activity             add a history entry
//   GET  /api/events               live updates (Server-Sent Events)
//
// No deletes: there is no DELETE route, and the database refuses them anyway.
// For now it listens on this PC only (127.0.0.1); sign-in is added before phones connect.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { loadConfig } from "./config.ts";
import { pool, tx } from "./db.ts";

const cfg = loadConfig();
const db = pool(cfg);
const COLLECTIONS = new Set(["customers", "products", "transports", "orders", "services", "receipts", "messages", "settings"]);
const VERSION = "0.1.0";

// ---------------------------------------------------------------- live updates
const listeners = new Set<ServerResponse>();
let listenClient: pg.Client | null = null;
async function startListening() {
  listenClient = new pg.Client({ ...cfg.db, application_name: "chittam-server-listen" });
  await listenClient.connect();
  await listenClient.query("LISTEN chittam_changes");
  listenClient.on("notification", (n) => { for (const res of listeners) res.write("data: " + (n.payload || "{}") + "\n\n"); });
  listenClient.on("error", () => setTimeout(() => startListening().catch(() => {}), 3000));
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

// ---------------------------------------------------------------- routes
async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://local");
  const parts = url.pathname.split("/").filter(Boolean);   // ["api", coll, id]
  const user = String(req.headers["x-user"] || "");
  if (parts[0] !== "api") return send(res, 404, { error: "Not found" });

  if (parts[1] === "health" && req.method === "GET") {
    const m = await db.query("SELECT name FROM schema_migrations ORDER BY name");
    const t = await db.query("SELECT now() AS now");
    return send(res, 200, { ok: true, server: VERSION, time: t.rows[0].now, migrations: m.rows.map((x) => x.name) });
  }

  if (parts[1] === "events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(": connected\n\n");
    listeners.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); listeners.delete(res); });
    return;
  }

  // one-time move from Firebase: the local app sends everything it read; it is
  // only saved as a backup file here (server/src/import-firebase.ts imports it)
  if (parts[1] === "import" && parts[2] === "firebase-snapshot" && req.method === "POST") {
    const snap = (await readBody(req, 300e6)) as { exportedAt?: string; by?: string; collections?: Record<string, unknown[]> };
    if (!snap.collections || typeof snap.collections !== "object") return send(res, 400, { error: "No collections in the export" });
    const dir = join(cfg.storage, "..", "backups", "firebase");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "firebase-export-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json");
    writeFileSync(file, JSON.stringify(snap));
    const counts = Object.fromEntries(Object.entries(snap.collections).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
    await db.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'app', 'firebase-export-saved', $2, $3)",
      [String(snap.by || user), file, { file, counts, exportedAt: snap.exportedAt || "" }]);
    console.log("Firebase export saved: " + file);
    return send(res, 201, { ok: true, file, counts });
  }

  if (parts[1] === "activity" && req.method === "POST") {
    const b = (await readBody(req)) as Record<string, unknown>;
    if (!b.action || !b.collection) return send(res, 400, { error: "action and collection are required" });
    await db.query("INSERT INTO activity (by_user, collection, record_id, action, name, details) VALUES ($1, $2, $3, $4, $5, $6)",
      [user, String(b.collection), b.recordId ? String(b.recordId) : null, String(b.action), String(b.name || ""), b.details ?? null]);
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
      // a phone resending the same entry gets the first answer back, nothing is saved twice
      if (entryKey) {
        const seen = await c.query("SELECT result FROM submissions WHERE entry_key = $1", [entryKey]);
        if (seen.rowCount) return { status: 200, body: { ...seen.rows[0].result, duplicate: true } };
      }
      const before = await c.query(`SELECT version, data FROM ${coll} WHERE id = $1 FOR UPDATE`, [id]);
      if (ifMatch !== null && before.rowCount && before.rows[0].version !== ifMatch)
        return { status: 409, body: { error: "Someone else changed this record. Reload and try again.", version: before.rows[0].version } };
      const saved = before.rowCount
        ? await c.query(`UPDATE ${coll} SET data = $2, updated_by = $3 WHERE id = $1 RETURNING id, version, updated_at, data`, [id, data, user])
        : await c.query(`INSERT INTO ${coll} (id, data, updated_by) VALUES ($1, $2, $3) RETURNING id, version, updated_at, data`, [id, data, user]);
      const action = before.rowCount ? "update" : "create";
      await c.query("INSERT INTO activity (by_user, collection, record_id, action, name, before, after) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [user, coll, id, action, String((data as Record<string, unknown>).name || (data as Record<string, unknown>).customerName || ""), before.rows[0]?.data ?? null, data]);
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
const LOCAL_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

const server = createServer((req, res) => {
  const origin = String(req.headers.origin || "");
  if (LOCAL_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User, X-Entry-Key, If-Match");
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
