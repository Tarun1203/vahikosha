// Local sign-in: passwords are kept only as scrypt hashes; a session is a
// random token (the server stores just its SHA-256) valid for 30 days.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";
import { inBusiness, type Db } from "./db.ts";
import { usable, type Membership, type Role } from "./roles.ts";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, PARAMS);
  return "scrypt$" + PARAMS.N + "$" + salt.toString("base64") + "$" + key.toString("base64");
}

export async function checkPassword(pw: string, stored: string | null) {
  const [kind, n, salt, key] = (stored || "").split("$");
  if (kind !== "scrypt" || !salt || !key) return false;
  const got = await scrypt(pw, Buffer.from(salt, "base64"), 32, { ...PARAMS, N: Number(n) || PARAMS.N });
  const want = Buffer.from(key, "base64");
  return got.length === want.length && timingSafeEqual(got, want);
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

export interface SessionUser {
  id: string; email: string; displayName: string;
  role: string;               // role in the chosen business ('' before one is chosen; 'support' for Chittam support)
  isSupport: boolean;
  businessId: string | null;  // the business this session works in
}

export interface BusinessChoice { id: string; name: string; role: Role }

// the businesses a person can open (active membership, active business, inside a CA's period)
export async function businessesOf(db: Db, userId: string): Promise<BusinessChoice[]> {
  const r = await db.query(`SELECT b.id, b.name, m.role FROM members m JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = $1 AND m.active AND b.status = 'active'
      AND (m.access_from IS NULL OR m.access_from <= current_date) AND (m.access_to IS NULL OR m.access_to >= current_date)
    ORDER BY b.name`, [userId]);
  return r.rows.map((x) => ({ id: x.id, name: x.name, role: x.role }));
}

// a person's membership of one business, or null
export async function membership(db: Db, userId: string, businessId: string): Promise<Membership | null> {
  const r = await db.query(`SELECT b.id, b.name, b.status, b.accountant_can_approve, m.role,
      to_char(m.access_from, 'YYYY-MM-DD') AS access_from, to_char(m.access_to, 'YYYY-MM-DD') AS access_to
    FROM members m JOIN businesses b ON b.id = m.business_id WHERE m.user_id = $1 AND m.business_id = $2 AND m.active`, [userId, businessId]);
  const x = r.rows[0];
  return x ? { businessId: x.id, businessName: x.name, businessStatus: x.status, role: x.role, accountantCanApprove: x.accountant_can_approve, accessFrom: x.access_from, accessTo: x.access_to } : null;
}

export async function login(db: pg.Pool, email: string, password: string, device: string) {
  const r = await db.query("SELECT id, email, display_name, password_hash, active, is_support FROM app_users WHERE lower(email) = lower($1)", [email.trim()]);
  const u = r.rows[0];
  const ok = u && u.active && (await checkPassword(password, u.password_hash));
  if (!ok) {
    await new Promise((res) => setTimeout(res, 800));   // slow down guessing
    return null;
  }
  const businesses = u.is_support ? [] : await businessesOf(db, u.id);
  if (!u.is_support && !businesses.length) {
    await new Promise((res) => setTimeout(res, 800));
    return { error: "This login isn't part of any business yet. Ask the owner to add you." };
  }
  // with one business, open it straight away; with several, the person picks one
  const chosen = businesses.length === 1 ? businesses[0] : null;
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions (token_hash, user_id, device, expires_at, business_id) VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)",
    [sha(token), u.id, device.slice(0, 200), SESSION_DAYS, chosen?.id ?? null]);
  if (chosen) await logIn(db, chosen.id, u.email, "signed-in", { device: device.slice(0, 200) });
  const user: SessionUser = { id: u.id, email: u.email, displayName: u.display_name, role: u.is_support ? "support" : chosen?.role ?? "", isSupport: u.is_support, businessId: chosen?.id ?? null };
  return { token, user, businesses };
}

// switch the session to another business the person belongs to
export async function chooseBusiness(db: pg.Pool, token: string, me: SessionUser, businessId: string) {
  if (me.isSupport) return null;
  const m = await membership(db, me.id, businessId);
  if (!m || !usable(m)) return null;
  await db.query("UPDATE sessions SET business_id = $2 WHERE token_hash = $1", [sha(token), businessId]);
  await logIn(db, businessId, me.email, "opened-business", {});
  return m;
}

// a history entry inside one business
async function logIn(db: pg.Pool, businessId: string, by: string, action: string, details: object) {
  await inBusiness(db, businessId, (c) => c.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'app', $2, $1, $3)", [by, action, details]));
}

export async function sessionUser(db: pg.Pool, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const r = await db.query(`UPDATE sessions s SET last_seen = now() FROM app_users u
    WHERE s.token_hash = $1 AND s.user_id = u.id AND s.ended_at IS NULL AND s.expires_at > now() AND u.active
    RETURNING u.id, u.email, u.display_name, u.is_support, s.business_id,
      (SELECT m.role FROM members m WHERE m.user_id = u.id AND m.business_id = s.business_id AND m.active) AS role`, [sha(token)]);
  const u = r.rows[0];
  return u ? { id: u.id, email: u.email, displayName: u.display_name, role: u.is_support ? "support" : u.role || "", isSupport: u.is_support, businessId: u.is_support ? null : u.business_id } : null;
}

export async function logout(db: pg.Pool, token: string) {
  await db.query("UPDATE sessions SET ended_at = now() WHERE token_hash = $1 AND ended_at IS NULL", [sha(token)]);
}
