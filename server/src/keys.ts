// Keys: the server only stores and hands out what devices made with
// shared/vahikosha-keys.ts. It never sees a passphrase, a recovery code or a
// business key, so it can't open any business's data.
//
// For the signed-in person (any business, or none chosen yet):
//   GET  /api/keys/me                 my key pair record (private half sealed with my passphrase)
//   PUT  /api/keys/me                 save it; later only a new passphrase for the same pair
// Inside the chosen business:
//   GET  /api/business/keys           key versions, my envelopes, whether a new version is due
//   POST /api/business/keys           owner: a new key version, with envelopes for the people who keep access
//   GET  /api/business/keys/waiting   owner: people who still need an envelope for the current version
//   POST /api/business/keys/grant     owner: give one person an envelope for the current version
//   GET  /api/business/recovery       owner: the recovery code's sealed key (used when recovering)
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { can, type Membership } from "./roles.ts";

const RECOVERY = "recovery";
const MAX = 20_000;   // no key record or envelope is anywhere near this long

type Send = (res: ServerResponse, status: number, body: unknown) => void;
type ReadBody = (req: IncomingMessage) => Promise<unknown>;

interface KeyRecord { publicKey: string; privateSealed: string; salt: string; iter: number }
const isText = (v: unknown, max = MAX): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
function keyRecord(b: unknown): KeyRecord | null {
  const r = b as Partial<KeyRecord> | null;
  if (!r || !isText(r.publicKey, 400) || !isText(r.privateSealed) || !isText(r.salt, 100)) return null;
  if (typeof r.iter !== "number" || !Number.isInteger(r.iter) || r.iter < 100_000 || r.iter > 10_000_000) return null;
  return { publicKey: r.publicKey, privateSealed: r.privateSealed, salt: r.salt, iter: r.iter };
}
const out = (x: { public_key: string; private_sealed: string; salt: string; iter: number }) =>
  ({ publicKey: x.public_key, privateSealed: x.private_sealed, salt: x.salt, iter: x.iter });

// the signed-in person's own key record (no business needed)
export async function personKeyRoutes(req: IncomingMessage, res: ServerResponse, parts: string[], userId: string, db: pg.Pool, send: Send, readBody: ReadBody) {
  if (parts[1] !== "keys" || parts[2] !== "me") return false;
  if (req.method === "GET") {
    const r = await db.query("SELECT public_key, private_sealed, salt, iter FROM person_keys WHERE user_id = $1", [userId]);
    send(res, r.rowCount ? 200 : 404, r.rowCount ? out(r.rows[0]) : { error: "No key yet. Set your passphrase to make one." });
    return true;
  }
  if (req.method === "PUT") {
    const k = keyRecord(await readBody(req));
    if (!k) { send(res, 400, { error: "That isn't a key record." }); return true; }
    try {
      const r = await db.query(`INSERT INTO person_keys (user_id, public_key, private_sealed, salt, iter) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (user_id) DO UPDATE SET public_key = EXCLUDED.public_key, private_sealed = EXCLUDED.private_sealed, salt = EXCLUDED.salt, iter = EXCLUDED.iter
        RETURNING (xmax = 0) AS created`, [userId, k.publicKey, k.privateSealed, k.salt, k.iter]);
      send(res, r.rows[0].created ? 201 : 200, { ok: true });
    } catch (e) {
      send(res, 409, { error: (e as Error).message });   // a different key pair for someone who already has one
    }
    return true;
  }
  return false;
}

interface Ctx {
  req: IncomingMessage; res: ServerResponse; parts: string[];
  userId: string; email: string; m: Membership; db: pg.Pool;
  run: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>;
  send: Send; readBody: ReadBody; refuse: (what: string) => void;
}

// active members of the business and whether they have a key pair
async function people(c: pg.PoolClient, business: string) {
  const r = await c.query(`SELECT m.user_id, u.email, p.public_key FROM members m JOIN app_users u ON u.id = m.user_id
    LEFT JOIN person_keys p ON p.user_id = m.user_id WHERE m.business_id = $1 AND m.active AND u.active`, [business]);
  return r.rows as { user_id: string; email: string; public_key: string | null }[];
}
const currentVersion = async (c: pg.PoolClient) =>
  ((await c.query("SELECT max(version) AS v FROM business_keys")).rows[0].v as number | null) ?? 0;

export async function businessKeyRoutes(x: Ctx) {
  const { req, res, parts, userId, email, m, db, run, send, readBody, refuse } = x;
  const biz = m.businessId;
  const route = parts[1] === "business" ? parts.slice(2).join("/") : "";
  const log = (c: pg.PoolClient, action: string, name: string, details: object) =>
    c.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'keys', $2, $3, $4)", [email, action, name, details]);

  if (route === "keys" && req.method === "GET") {
    const r = await run(async (c) => {
      const versions = (await c.query("SELECT version, key_check, retired_at FROM business_keys ORDER BY version")).rows;
      const mine = (await c.query("SELECT version, envelope FROM key_envelopes WHERE holder = $1 AND revoked_at IS NULL ORDER BY version", [userId])).rows;
      const rec = (await c.query("SELECT public_key FROM business_recovery")).rows[0];
      return { versions, mine, rec };
    });
    const due = (await db.query("SELECT key_rotation_due FROM businesses WHERE id = $1", [biz])).rows[0]?.key_rotation_due ?? false;
    send(res, 200, {
      current: r.versions.length ? r.versions[r.versions.length - 1].version : null,
      versions: r.versions.map((v) => ({ version: v.version, check: v.key_check, retired: !!v.retired_at })),
      envelopes: r.mine.map((e) => ({ version: e.version, envelope: e.envelope })),
      recoveryPublicKey: r.rec?.public_key ?? null,
      rotationDue: due,
    });
    return true;
  }

  if (route === "keys" && req.method === "POST") {
    if (!can(m, "business.manage")) { refuse("make a new business key"); return true; }
    const b = (await readBody(req)) as { version?: unknown; check?: unknown; envelopes?: unknown; recovery?: unknown };
    const envs = (b.envelopes && typeof b.envelopes === "object" ? b.envelopes : {}) as Record<string, unknown>;
    const recovery = b.recovery === undefined ? null : keyRecord(b.recovery);
    if (typeof b.version !== "number" || !isText(b.check, 200) || (b.recovery !== undefined && !recovery) || Object.values(envs).some((e) => !isText(e)))
      return send(res, 400, { error: "That isn't a key version." }), true;
    const result = await run(async (c) => {
      const current = await currentVersion(c);
      if (b.version !== current + 1) return { status: 409, body: { error: "The key changed meanwhile (now version " + current + "). Reload and try again." } };
      const hasRecovery = (await c.query("SELECT 1 FROM business_recovery")).rowCount;
      if (!hasRecovery && !recovery) return { status: 400, body: { error: "The first key needs a recovery code." } };
      if (!envs[userId]) return { status: 400, body: { error: "Keep a copy for yourself: your envelope is missing." } };
      if (!envs[RECOVERY]) return { status: 400, body: { error: "The recovery code needs an envelope too." } };
      const ok = new Map((await people(c, biz)).filter((p) => p.public_key).map((p) => [p.user_id, p]));
      const strangers = Object.keys(envs).filter((h) => h !== RECOVERY && !ok.has(h));
      if (strangers.length) return { status: 400, body: { error: "Not in this business, or without a key: " + strangers.join(", ") } };

      if (recovery) {
        await c.query(`INSERT INTO business_recovery (public_key, private_sealed, salt, iter, created_by) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (business_id) DO UPDATE SET public_key = EXCLUDED.public_key, private_sealed = EXCLUDED.private_sealed, salt = EXCLUDED.salt, iter = EXCLUDED.iter,
            created_by = EXCLUDED.created_by, created_at = now()`, [recovery.publicKey, recovery.privateSealed, recovery.salt, recovery.iter, email]);
      }
      await c.query("UPDATE business_keys SET retired_at = now() WHERE retired_at IS NULL");
      await c.query("INSERT INTO business_keys (version, key_check, created_by) VALUES ($1, $2, $3)", [b.version, b.check, email]);
      for (const [holder, envelope] of Object.entries(envs))
        await c.query("INSERT INTO key_envelopes (version, holder, envelope, created_by) VALUES ($1, $2, $3, $4)", [b.version, holder, envelope, email]);
      const waiting = [...ok.values()].filter((p) => !envs[p.user_id]).map((p) => p.email);
      await log(c, current ? "key-renewed" : "key-made", "Key version " + b.version, { holders: Object.keys(envs).length, newRecoveryCode: !!recovery, waiting });
      return { status: 201, body: { version: b.version, waiting } };
    });
    if (result.status === 201) await db.query("UPDATE businesses SET key_rotation_due = false WHERE id = $1", [biz]);
    send(res, result.status, result.body);
    return true;
  }

  if (route === "keys/waiting" && req.method === "GET") {
    if (!can(m, "business.manage")) { refuse("see who is waiting for the key"); return true; }
    const r = await run(async (c) => {
      const v = await currentVersion(c);
      const have = new Set((await c.query("SELECT holder FROM key_envelopes WHERE version = $1", [v])).rows.map((x) => x.holder));
      return { v, list: (await people(c, biz)).filter((p) => !have.has(p.user_id)) };
    });
    send(res, 200, {
      version: r.v || null,
      waiting: r.list.filter((p) => p.public_key).map((p) => ({ userId: p.user_id, email: p.email, publicKey: p.public_key })),
      noKeyYet: r.list.filter((p) => !p.public_key).map((p) => p.email),
    });
    return true;
  }

  if (route === "keys/grant" && req.method === "POST") {
    if (!can(m, "business.manage")) { refuse("give someone the key"); return true; }
    const b = (await readBody(req)) as { holder?: unknown; version?: unknown; envelope?: unknown };
    if (!isText(b.holder, 200) || !isText(b.envelope) || typeof b.version !== "number") return send(res, 400, { error: "That isn't an envelope." }), true;
    const result = await run(async (c) => {
      const v = await currentVersion(c);
      if (b.version !== v) return { status: 409, body: { error: "The key changed meanwhile. Reload and try again." } };
      const p = (await people(c, biz)).find((x) => x.user_id === b.holder);
      if (!p?.public_key) return { status: 400, body: { error: "That person isn't in this business or has no key yet." } };
      const had = (await c.query("SELECT revoked_at FROM key_envelopes WHERE version = $1 AND holder = $2", [v, b.holder])).rows[0];
      if (had) return { status: 409, body: { error: had.revoked_at ? "This person left after this key was made. Make a new key version to give them access again." : "This person already has the key." } };
      await c.query("INSERT INTO key_envelopes (version, holder, envelope, created_by) VALUES ($1, $2, $3, $4)", [v, b.holder, b.envelope, email]);
      await log(c, "key-given", p.email, { version: v });
      return { status: 201, body: { ok: true } };
    });
    send(res, result.status, result.body);
    return true;
  }

  if (route === "recovery" && req.method === "GET") {
    if (!can(m, "business.manage")) { refuse("open the recovery key"); return true; }
    const r = await run((c) => c.query("SELECT public_key, private_sealed, salt, iter FROM business_recovery"));
    send(res, r.rowCount ? 200 : 404, r.rowCount ? out(r.rows[0]) : { error: "No recovery code yet." });
    return true;
  }
  return false;
}
