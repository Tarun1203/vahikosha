// A key for each business, and each person's own access to it.
// The first tests need nothing; the server tests need VAHIKOSHA_TEST_ADMIN
// (see businesses.test.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import pg from "pg";
import * as K from "../../shared/vahikosha-keys.ts";

const ITER = 100_000;   // faster than the real 600 000, same code
const BIZ = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------- on the device

test("records sealed with the business key open only with that key", async () => {
  const k1 = K.newBusinessKey(1), k2 = K.newBusinessKey(2);
  const s = await K.sealRecord(k1, { name: "Ravi Stores", amount: 12500 });
  assert.deepEqual(await K.openRecord(k1, s), { name: "Ravi Stores", amount: 12500 });
  await assert.rejects(K.openRecord(k2, s));
  const bad = K.unb64(s); bad[20] ^= 1;
  await assert.rejects(K.openRecord(k1, K.b64(bad)));
});

test("a person's key opens only with their passphrase, and a new passphrase keeps the same key", async () => {
  const rec = await K.newPersonKey("my secret phrase", ITER);
  assert.ok(await K.unlockPersonKey(rec, "my secret phrase"));
  assert.equal(await K.unlockPersonKey(rec, "wrong phrase!"), null);
  const moved = await K.changePassphrase(rec, "my secret phrase", "a new phrase 2", ITER);
  assert.ok(moved);
  assert.equal(moved.publicKey, rec.publicKey);
  assert.ok(await K.unlockPersonKey(moved, "a new phrase 2"));
  assert.equal(await K.unlockPersonKey(moved, "my secret phrase"), null);
  await assert.rejects(K.newPersonKey("short", ITER));
});

test("an envelope opens only for its holder, business and version", async () => {
  const key = K.newBusinessKey(3);
  const asha = await K.newPersonKey("asha passphrase", ITER), ravi = await K.newPersonKey("ravi passphrase", ITER);
  const env = await K.makeEnvelope(key, asha.publicKey, { business: BIZ, holder: "asha" });
  const ashaKey = (await K.unlockPersonKey(asha, "asha passphrase"))!, raviKey = (await K.unlockPersonKey(ravi, "ravi passphrase"))!;
  const got = await K.openEnvelope(env, ashaKey, { business: BIZ, version: 3, holder: "asha" });
  assert.deepEqual(got?.raw, key.raw);
  assert.equal(await K.openEnvelope(env, raviKey, { business: BIZ, version: 3, holder: "asha" }), null);
  // moved to another business, version or person: refused
  assert.equal(await K.openEnvelope(env, ashaKey, { business: "other", version: 3, holder: "asha" }), null);
  assert.equal(await K.openEnvelope(env, ashaKey, { business: BIZ, version: 4, holder: "asha" }), null);
  assert.equal(await K.openEnvelope(env, ashaKey, { business: BIZ, version: 3, holder: "ravi" }), null);
});

test("the recovery code is easy to type back", async () => {
  const code = K.newRecoveryCode();
  assert.match(code, /^([A-Z2-9]{4}-){5}[A-Z2-9]{4}$/);
  const rec = await K.newRecoveryKey(code, ITER);
  assert.ok(await K.unlockRecoveryKey(rec, code.toLowerCase().replace(/-/g, " ")));
  assert.equal(await K.unlockRecoveryKey(rec, K.newRecoveryCode()), null);
});

test("the key check matches only its own key and version", async () => {
  const k = K.newBusinessKey(1);
  assert.equal(await K.keyCheck(k), await K.keyCheck({ version: 1, raw: k.raw }));
  assert.notEqual(await K.keyCheck(k), await K.keyCheck({ version: 2, raw: k.raw }));
  assert.notEqual(await K.keyCheck(k), await K.keyCheck(K.newBusinessKey(1)));
});

// ---------------------------------------------------------------- with the server

const ADMIN = process.env.VAHIKOSHA_TEST_ADMIN || "";
const skip = ADMIN ? false : "set VAHIKOSHA_TEST_ADMIN to run the server tests";
const dbName = "vahikosha_keys_" + process.pid;
const appUser = "vahikosha_test_app";
const appPw = "test-" + Math.random().toString(36).slice(2);
const userPw = "test-password-1";
let admin: pg.Client, port = 0, server: ChildProcess | null = null, A = "";
const cfg = () => ({ host: new URL(ADMIN).hostname, port: Number(new URL(ADMIN).port || 5432), database: dbName, user: appUser, password: appPw });

async function api(path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const r = await fetch("http://127.0.0.1:" + port + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: "Bearer " + opts.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
async function addUser(email: string, role: string) {
  const { hashPassword } = await import("../src/auth.ts");
  const c = new pg.Client(cfg()); await c.connect();
  await c.query("INSERT INTO app_users (id, email, password_hash) VALUES ($1, $1, $2)", [email, await hashPassword(userPw)]);
  await c.query("INSERT INTO members (business_id, user_id, role) VALUES ($1, $2, $3)", [A, email, role]);
  await c.end();
  const r = await api("/api/login", { body: { email, password: userPw } });
  assert.equal(r.status, 200);
  return String(r.body.token);
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${appUser}') THEN CREATE ROLE ${appUser} LOGIN; END IF; END $$`);
  await admin.query(`ALTER ROLE ${appUser} PASSWORD '${appPw}'`);
  await admin.query(`CREATE DATABASE ${dbName} OWNER ${appUser}`);
  const dir = mkdtempSync(join(tmpdir(), "vahikosha-keys-"));
  port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
  const cfgPath = join(dir, "server.json");
  writeFileSync(cfgPath, JSON.stringify({ db: cfg(), http: { host: "127.0.0.1", port }, storage: join(dir, "storage") }));
  process.env.CHITTAM_CONFIG = cfgPath;
  const { migrate } = await import("../src/migrate.ts");
  await migrate(() => {});
  const c = new pg.Client(cfg()); await c.connect();
  A = (await c.query("INSERT INTO businesses (name) VALUES ('Alpha Traders') RETURNING id")).rows[0].id;
  await c.end();
  server = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "index.ts")], { env: { ...process.env, CHITTAM_CONFIG: cfgPath, CHITTAM_FIREBASE_COPY: "off" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch("http://127.0.0.1:" + port + "/api/health")).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server didn't start");
});

after(async () => {
  if (skip) return;
  server?.kill();
  await new Promise((r) => setTimeout(r, 300));
  await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
});

test("server: owner makes the key, gives it to the team, and a leaver is locked out of the next version", { skip }, async () => {
  const owner = await addUser("owner@alpha.test", "owner");
  const acct = await addUser("acct@alpha.test", "accountant");
  const staff = await addUser("staff@alpha.test", "staff");

  // each person makes their key pair on their device and saves it
  const recs: Record<string, K.PersonKeyRecord> = {};
  for (const [who, t] of [["owner@alpha.test", owner], ["acct@alpha.test", acct], ["staff@alpha.test", staff]] as const) {
    recs[who] = await K.newPersonKey(who + " passphrase", ITER);
    assert.equal((await api("/api/keys/me", { token: t, method: "PUT", body: recs[who] })).status, 201);
  }
  // a new device downloads it and unlocks it with the passphrase
  const back = (await api("/api/keys/me", { token: acct })).body as K.PersonKeyRecord;
  assert.ok(await K.unlockPersonKey(back, "acct@alpha.test passphrase"));
  // a different key pair can't replace one in use; a new passphrase can
  assert.equal((await api("/api/keys/me", { token: acct, method: "PUT", body: await K.newPersonKey("other pass 123", ITER) })).status, 409);
  const reSealed = await K.changePassphrase(back, "acct@alpha.test passphrase", "acct new passphrase", ITER);
  assert.equal((await api("/api/keys/me", { token: acct, method: "PUT", body: reSealed })).status, 200);

  // only the owner makes the key
  const code = K.newRecoveryCode();
  const recovery = await K.newRecoveryKey(code, ITER);
  const v1 = K.newBusinessKey(1);
  const envFor = (k: K.BusinessKey, who: string, pub: string) => K.makeEnvelope(k, pub, { business: A, holder: who });
  const first = {
    version: 1, check: await K.keyCheck(v1), recovery,
    envelopes: { "owner@alpha.test": await envFor(v1, "owner@alpha.test", recs["owner@alpha.test"].publicKey), recovery: await envFor(v1, "recovery", recovery.publicKey) },
  };
  assert.equal((await api("/api/business/keys", { token: acct, body: first })).status, 403);
  const made = await api("/api/business/keys", { token: owner, body: first });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.waiting.sort(), ["acct@alpha.test", "staff@alpha.test"]);

  // the owner gives the others their envelopes
  const waiting = (await api("/api/business/keys/waiting", { token: owner })).body;
  assert.equal(waiting.waiting.length, 2);
  for (const w of waiting.waiting)
    assert.equal((await api("/api/business/keys/grant", { token: owner, body: { holder: w.userId, version: 1, envelope: await envFor(v1, w.userId, w.publicKey) } })).status, 201);

  // the accountant opens the key and reads a record the owner sealed
  const sealed = await K.sealRecord(v1, { name: "Ravi Stores" });
  const mine = (await api("/api/business/keys", { token: acct })).body;
  assert.equal(mine.current, 1);
  const accPriv = (await K.unlockPersonKey(reSealed!, "acct new passphrase"))!;
  const got = await K.openEnvelope(mine.envelopes[0].envelope, accPriv, { business: A, version: 1, holder: "acct@alpha.test" });
  assert.ok(got);
  assert.equal(await K.keyCheck(got), mine.versions[0].check);
  assert.deepEqual(await K.openRecord(got, sealed), { name: "Ravi Stores" });

  // the staff member leaves: their envelope is withdrawn at once, and a new version is due
  const c = new pg.Client(cfg()); await c.connect();
  await c.query("UPDATE members SET active = false WHERE business_id = $1 AND user_id = 'staff@alpha.test'", [A]);
  await c.end();
  assert.equal((await api("/api/business/keys", { token: staff })).status, 403);
  const ownerView = (await api("/api/business/keys", { token: owner })).body;
  assert.equal(ownerView.rotationDue, true);

  // the owner makes version 2 for the people who stay; the leaver can't be included
  const v2 = K.newBusinessKey(2);
  const second = (extra: Record<string, string> = {}) => ({
    version: 2, check: "", envelopes: { ...extra },
  });
  const s2 = second({
    "owner@alpha.test": await envFor(v2, "owner@alpha.test", recs["owner@alpha.test"].publicKey),
    "acct@alpha.test": await envFor(v2, "acct@alpha.test", recs["acct@alpha.test"].publicKey),
    recovery: await envFor(v2, "recovery", ownerView.recoveryPublicKey),
  });
  s2.check = await K.keyCheck(v2);
  const withLeaver = { ...s2, envelopes: { ...s2.envelopes, "staff@alpha.test": await envFor(v2, "staff@alpha.test", recs["staff@alpha.test"].publicKey) } };
  assert.equal((await api("/api/business/keys", { token: owner, body: withLeaver })).status, 400);
  assert.equal((await api("/api/business/keys", { token: owner, body: s2 })).status, 201);
  assert.equal((await api("/api/business/keys", { token: owner })).body.rotationDue, false);
  // an old version number is refused (someone else renewed meanwhile)
  assert.equal((await api("/api/business/keys", { token: owner, body: s2 })).status, 409);

  // the recovery code still opens the newest key
  const rec = (await api("/api/business/recovery", { token: owner })).body as K.PersonKeyRecord;
  const recPriv = (await K.unlockRecoveryKey(rec, code))!;
  const db = new pg.Client({ ...cfg(), options: "-c vahikosha.business_id=" + A }); await db.connect();
  const rEnv = (await db.query("SELECT envelope FROM key_envelopes WHERE version = 2 AND holder = 'recovery'")).rows[0].envelope;
  const fromRecovery = await K.openEnvelope(rEnv, recPriv, { business: A, version: 2, holder: "recovery" });
  assert.deepEqual(fromRecovery?.raw, v2.raw);
  // and the database holds nothing that is the key itself
  const dump = JSON.stringify((await db.query("SELECT * FROM key_envelopes")).rows) + JSON.stringify((await db.query("SELECT * FROM business_keys")).rows);
  assert.ok(!dump.includes(K.b64(v1.raw)) && !dump.includes(K.b64(v2.raw)));
  assert.ok((await db.query("SELECT revoked_at FROM key_envelopes WHERE holder = 'staff@alpha.test'")).rows[0].revoked_at);
  // envelopes can't be swapped afterwards
  await assert.rejects(db.query("UPDATE key_envelopes SET envelope = 'x' WHERE holder = 'acct@alpha.test'"));
  await db.end();
});
