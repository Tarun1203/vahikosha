// Many businesses in one database: each business sees only its own data, the
// five roles get what they should, and switched-off modules are refused.
//
// Needs a PostgreSQL server to make a throwaway database on (it is dropped at
// the end). Give the admin login in VAHIKOSHA_TEST_ADMIN, for example
//   VAHIKOSHA_TEST_ADMIN=postgres://postgres:secret@localhost:5432/postgres npm test
// Without it the tests are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import pg from "pg";

const ADMIN = process.env.VAHIKOSHA_TEST_ADMIN || "";
const skip = ADMIN ? false : "set VAHIKOSHA_TEST_ADMIN to run the database tests";

const CHITTAM = "00000000-0000-4000-8000-000000000001";
const dbName = "vahikosha_test_" + process.pid;
const appUser = "vahikosha_test_app";
const appPw = "test-" + Math.random().toString(36).slice(2);
const userPw = "test-password-1";
let admin: pg.Client;
let cfgPath = "";
let port = 0;
let server: ChildProcess | null = null;
let A = "", B = "";   // two new businesses

const cfg = () => ({ host: new URL(ADMIN).hostname, port: Number(new URL(ADMIN).port || 5432), database: dbName, user: appUser, password: appPw });
// a connection working for one business (or for none)
async function as(business: string | null) {
  const c = new pg.Client({ ...cfg(), ...(business ? { options: "-c vahikosha.business_id=" + business } : {}) });
  await c.connect();
  return c;
}
async function freePort() {
  return new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
}
async function api(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const r = await fetch("http://127.0.0.1:" + port + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: "Bearer " + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> & unknown[] };
}
const signIn = async (email: string) => (await api("/api/login", { body: { email, password: userPw } }));
async function tokenFor(email: string) {
  const r = await signIn(email);
  assert.equal(r.status, 200, email + ": " + JSON.stringify(r.body));
  return String(r.body.token);
}
async function addUser(email: string, roleIn: Record<string, string>, opts: { support?: boolean; from?: string; to?: string } = {}) {
  const { hashPassword } = await import("../src/auth.ts");
  const c = await as(null);
  await c.query("INSERT INTO app_users (id, email, password_hash, is_support) VALUES ($1, $1, $2, $3)", [email, await hashPassword(userPw), !!opts.support]);
  for (const [biz, role] of Object.entries(roleIn))
    await c.query("INSERT INTO members (business_id, user_id, role, access_from, access_to) VALUES ($1, $2, $3, $4, $5)", [biz, email, role, opts.from ?? null, opts.to ?? null]);
  await c.end();
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appUser}') THEN CREATE ROLE ${appUser} LOGIN; END IF; END $$`);
  await admin.query(`ALTER ROLE ${appUser} PASSWORD '${appPw}'`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${appUser}`);

  const dir = mkdtempSync(join(tmpdir(), "vahikosha-test-"));
  port = await freePort();
  cfgPath = join(dir, "server.json");
  writeFileSync(cfgPath, JSON.stringify({ db: cfg(), http: { host: "127.0.0.1", port }, storage: join(dir, "storage") }));
  process.env.CHITTAM_CONFIG = cfgPath;
  const { migrate } = await import("../src/migrate.ts");

  // the database as it is on the office PC today (before 010), with some data in it
  await migrate(() => {}, "009_firebase_copy.sql");
  const old = await as(null);
  await old.query("INSERT INTO app_users (id, email, role) VALUES ('owner@chittam.test', 'owner@chittam.test', 'owner'), ('manager@chittam.test', 'manager@chittam.test', 'manager')");
  await old.query(`INSERT INTO customers (id, data) VALUES ('c1', '{"name":"Old Customer"}')`);
  await old.query(`INSERT INTO settings (id, data) VALUES ('app', '{"shop":"Chittam"}')`);
  await old.query("INSERT INTO ledgers (company_id, name, group_name) VALUES ('business', 'Cash', 'Cash-in-Hand')");
  await old.end();

  await migrate(() => {});

  const c = await as(null);
  A = (await c.query("INSERT INTO businesses (name) VALUES ('Alpha Traders') RETURNING id")).rows[0].id;
  B = (await c.query("INSERT INTO businesses (name) VALUES ('Beta Distributors') RETURNING id")).rows[0].id;
  await c.end();
});

after(async () => {
  if (skip) return;
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

// ---------------------------------------------------------------- the database

test("the data already there becomes Chittam Enterprises' data", { skip }, async () => {
  const c = await as(CHITTAM);
  assert.equal((await c.query("SELECT data->>'name' AS n FROM customers WHERE id = 'c1'")).rows[0]?.n, "Old Customer");
  assert.equal((await c.query("SELECT count(*)::int AS n FROM ledgers")).rows[0].n, 1);
  const roles = (await c.query("SELECT user_id, role FROM members WHERE business_id = $1 ORDER BY user_id", [CHITTAM])).rows;
  assert.deepEqual(roles, [{ user_id: "manager@chittam.test", role: "accountant" }, { user_id: "owner@chittam.test", role: "owner" }]);
  await c.end();
});

test("a connection that hasn't said which business sees nothing and saves nothing", { skip }, async () => {
  const c = await as(null);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM customers")).rows[0].n, 0);
  assert.equal((await c.query("SELECT count(*)::int AS n FROM trial_balance")).rows[0].n, 0);
  await assert.rejects(c.query(`INSERT INTO customers (id, data) VALUES ('x', '{}')`));
  await c.end();
});

test("two businesses can use the same ids, and each sees only its own rows", { skip }, async () => {
  const a = await as(A), b = await as(B);
  await a.query(`INSERT INTO customers (id, data) VALUES ('c1', '{"name":"Alpha customer"}')`);
  await b.query(`INSERT INTO customers (id, data) VALUES ('c1', '{"name":"Beta customer"}')`);
  await a.query(`INSERT INTO settings (id, data) VALUES ('app', '{}')`);
  await b.query(`INSERT INTO settings (id, data) VALUES ('app', '{}')`);
  await a.query("INSERT INTO companies (id, label) VALUES ('business', 'Alpha Traders')");
  await b.query("INSERT INTO companies (id, label) VALUES ('business', 'Beta Distributors')");
  assert.deepEqual((await a.query("SELECT data->>'name' AS n FROM customers")).rows, [{ n: "Alpha customer" }]);
  assert.deepEqual((await b.query("SELECT data->>'name' AS n FROM customers")).rows, [{ n: "Beta customer" }]);
  await a.end(); await b.end();
});

test("a business can't change, or save into, another business's data", { skip }, async () => {
  const b = await as(B);
  const r = await b.query(`UPDATE customers SET data = '{"name":"changed"}' WHERE business_id = $1`, [A]);
  assert.equal(r.rowCount, 0);
  await assert.rejects(b.query(`INSERT INTO customers (business_id, id, data) VALUES ($1, 'c9', '{}')`, [A]));
  // the database refuses switching it off for a connection that isn't the admin
  await assert.rejects(b.query("SET row_security = off; SELECT * FROM customers"));
  const a = await as(A);
  assert.equal((await a.query("SELECT data->>'name' AS n FROM customers WHERE id = 'c1'")).rows[0].n, "Alpha customer");
  await a.end(); await b.end();
});

test("accounting rows can only point inside their own business", { skip }, async () => {
  const b = await as(B);
  // Beta has no company "cash"; Chittam does: still refused
  await assert.rejects(b.query("INSERT INTO ledgers (company_id, name) VALUES ('cash', 'Petty cash')"));
  await b.query("INSERT INTO financial_years (company_id, starts, ends) VALUES ('business', '2026-04-01', '2027-03-31')");
  await b.query("INSERT INTO ledgers (company_id, name, group_name) VALUES ('business', 'Cash', 'Cash-in-Hand'), ('business', 'Ravi', 'Sundry Debtors')");
  await b.query("BEGIN");
  const v = await b.query(`INSERT INTO vouchers (company_id, vtype, base_type, number, vdate, party, owner, entry_key)
    VALUES ('business', 'Receipt', 'Receipt', '1', '2026-11-20', 'Ravi', 'app', 'beta-1') RETURNING id`);
  await b.query("INSERT INTO voucher_entries (voucher_id, line, ledger, amount) VALUES ($1, 1, 'Cash', 500), ($1, 2, 'Ravi', -500)", [v.rows[0].id]);
  await b.query("COMMIT");
  const tb = (await b.query("SELECT ledger, debit, credit FROM trial_balance ORDER BY ledger")).rows;
  assert.deepEqual(tb, [{ ledger: "Cash", debit: 500, credit: 0 }, { ledger: "Ravi", debit: 0, credit: 500 }]);
  // Alpha's reports don't include Beta's voucher, and Alpha can't add lines to it
  const a = await as(A);
  assert.equal((await a.query("SELECT count(*)::int AS n FROM trial_balance")).rows[0].n, 0);
  await assert.rejects(a.query("INSERT INTO voucher_entries (voucher_id, line, ledger, amount) VALUES ($1, 3, 'Cash', 1)", [v.rows[0].id]));
  await a.end(); await b.end();
});

test("Chittam support can't be made a member of a business", { skip }, async () => {
  await addUser("help@chittam.test", {}, { support: true });
  const c = await as(null);
  await assert.rejects(c.query("INSERT INTO members (business_id, user_id, role) VALUES ($1, 'help@chittam.test', 'staff')", [A]));
  await c.end();
});

test("the old rules still hold (checks from check.ts)", { skip }, async () => {
  const c = await as(A);
  await assert.rejects(c.query("DELETE FROM customers WHERE id = 'c1'"));
  await assert.rejects(c.query("TRUNCATE customers"));
  await assert.rejects(c.query("DELETE FROM members"));
  await c.end();
});

// ---------------------------------------------------------------- the server

test("server: start", { skip }, async () => {
  await admin.query("SELECT 1");
  server = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.ts")], {
    env: { ...process.env, CHITTAM_CONFIG: cfgPath, CHITTAM_FIREBASE_COPY: "off", CHITTAM_MIRROR: "off" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  server.stdout?.on("data", (d) => (out += d));
  server.stderr?.on("data", (d) => (out += d));
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch("http://127.0.0.1:" + port + "/api/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail("server didn't start: " + out);
});

test("server: a person in one business goes straight into it", { skip }, async () => {
  await addUser("owner@alpha.test", { [A]: "owner" });
  const r = await signIn("owner@alpha.test");
  assert.equal(r.status, 200);
  assert.equal((r.body.user as { businessId: string }).businessId, A);
  const list = await api("/api/customers", { token: String(r.body.token) });
  assert.deepEqual(list.body.map((x: { name: string }) => x.name), ["Alpha customer"]);
});

test("server: a person in two businesses picks one, and sees only that one", { skip }, async () => {
  await addUser("ca@both.test", { [A]: "accountant", [B]: "staff" });
  const r = await signIn("ca@both.test");
  assert.equal((r.body.user as { businessId: string | null }).businessId, null);
  assert.equal((r.body.businesses as unknown[]).length, 2);
  const t = String(r.body.token);
  assert.equal((await api("/api/customers", { token: t })).status, 409);
  assert.equal((await api("/api/business/select", { token: t, body: { businessId: B } })).status, 200);
  assert.deepEqual((await api("/api/customers", { token: t })).body.map((x: { name: string }) => x.name), ["Beta customer"]);
  assert.equal((await api("/api/business", { token: t })).body.role, "staff");
  // and can't pick a business they aren't in
  assert.equal((await api("/api/business/select", { token: t, body: { businessId: CHITTAM } })).status, 403);
});

test("server: someone in no business can't sign in", { skip }, async () => {
  await addUser("nobody@x.test", {});
  assert.equal((await signIn("nobody@x.test")).status, 403);
});

test("server: roles", { skip }, async () => {
  await addUser("staff@alpha.test", { [A]: "staff" });
  await addUser("acct@alpha.test", { [A]: "accountant" });
  await addUser("ca@alpha.test", { [A]: "outside_ca" }, { from: "2025-04-01", to: "2099-03-31" });
  await addUser("oldca@alpha.test", { [A]: "outside_ca" }, { from: "2020-04-01", to: "2021-03-31" });
  const owner = await tokenFor("owner@alpha.test"), staff = await tokenFor("staff@alpha.test"), acct = await tokenFor("acct@alpha.test"), ca = await tokenFor("ca@alpha.test");
  const put = (t: string, path: string, body: unknown) => api(path, { token: t, method: "PUT", body });

  // staff: records yes, settings and history no
  assert.equal((await put(staff, "/api/customers/c2", { name: "New shop" })).status, 201);
  assert.equal((await put(staff, "/api/settings/app", { x: 1 })).status, 403);
  assert.equal((await api("/api/history", { token: staff })).status, 403);
  // outside CA: reads, never changes
  assert.equal((await api("/api/customers", { token: ca })).status, 200);
  assert.equal((await put(ca, "/api/customers/c2", { name: "x" })).status, 403);
  // an outside CA whose period is over can't sign in
  assert.equal((await signIn("oldca@alpha.test")).status, 403);
  // accountant: history yes, team and settings no
  assert.equal((await api("/api/history", { token: acct })).status, 200);
  assert.equal((await api("/api/business/members", { token: acct })).status, 403);
  assert.equal((await put(acct, "/api/business/modules", { orders: false })).status, 403);
  // owner: the team list
  const team = await api("/api/business/members", { token: owner });
  assert.equal(team.status, 200);
  assert.ok(team.body.some((x: { email: string; role: string }) => x.email === "ca@alpha.test" && x.role === "outside_ca"));
});

test("server: the Accountant approves entries only when the owner allows it", { skip }, async () => {
  const owner = await tokenFor("owner@alpha.test"), acct = await tokenFor("acct@alpha.test");
  const perms = async () => (await api("/api/business", { token: acct })).body.permissions as string[];
  assert.ok(!(await perms()).includes("entries.approve"));
  assert.equal((await api("/api/business/approval", { token: owner, method: "PUT", body: { accountantCanApprove: true } })).status, 200);
  assert.ok((await perms()).includes("entries.approve"));
  await api("/api/business/approval", { token: owner, method: "PUT", body: { accountantCanApprove: false } });
  assert.ok(!(await perms()).includes("entries.approve"));
  // the owner always can
  assert.ok(((await api("/api/business", { token: owner })).body.permissions as string[]).includes("entries.approve"));
});

test("server: a module the owner switched off is refused", { skip }, async () => {
  const owner = await tokenFor("owner@alpha.test");
  assert.equal((await api("/api/orders", { token: owner })).status, 200);
  const r = await api("/api/business/modules", { token: owner, method: "PUT", body: { orders: false } });
  assert.equal((r.body.modules as Record<string, boolean>).orders, false);
  const off = await api("/api/orders", { token: owner });
  assert.equal(off.status, 403);
  assert.match(String(off.body.error), /Orders module is switched off/);
  // other businesses are not affected
  const both = await tokenFor("ca@both.test");
  await api("/api/business/select", { token: both, body: { businessId: B } });
  assert.equal((await api("/api/orders", { token: both })).status, 200);
  await api("/api/business/modules", { token: owner, method: "PUT", body: { orders: true } });
  assert.equal((await api("/api/orders", { token: owner })).status, 200);
});

test("server: Chittam support sees account status, never business data", { skip }, async () => {
  const t = await tokenFor("help@chittam.test");
  assert.equal((await api("/api/customers", { token: t })).status, 403);
  assert.equal((await api("/api/tally/balances", { token: t })).status, 403);
  assert.equal((await api("/api/history", { token: t })).status, 403);
  const list = await api("/api/support/businesses", { token: t });
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.body[0]).sort(), ["createdAt", "id", "members", "name", "status"]);
});

test("server: Tally sync and the Firebase copy stay Chittam-only for now", { skip }, async () => {
  const owner = await tokenFor("owner@alpha.test");
  assert.equal((await api("/api/tally/sync", { token: owner, body: {} })).status, 400);
  assert.equal((await api("/api/firebase/copy", { token: owner, body: {} })).status, 400);
});
