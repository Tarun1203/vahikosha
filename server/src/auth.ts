// Local sign-in: passwords are kept only as scrypt hashes; a session is a
// random token (the server stores just its SHA-256) valid for 30 days.
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type pg from "pg";

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

export interface SessionUser { id: string; email: string; displayName: string; role: string }

export async function login(db: pg.Pool, email: string, password: string, device: string) {
  const r = await db.query("SELECT id, email, display_name, role, password_hash, active FROM app_users WHERE lower(email) = lower($1)", [email.trim()]);
  const u = r.rows[0];
  const ok = u && u.active && (await checkPassword(password, u.password_hash));
  if (!ok) {
    await new Promise((res) => setTimeout(res, 800));   // slow down guessing
    return null;
  }
  const token = randomBytes(32).toString("base64url");
  await db.query("INSERT INTO sessions (token_hash, user_id, device, expires_at) VALUES ($1, $2, $3, now() + make_interval(days => $4))",
    [sha(token), u.id, device.slice(0, 200), SESSION_DAYS]);
  await db.query("INSERT INTO activity (by_user, collection, action, name, details) VALUES ($1, 'app', 'signed-in', $1, $2)", [u.email, { device: device.slice(0, 200) }]);
  return { token, user: { id: u.id, email: u.email, displayName: u.display_name, role: u.role } as SessionUser };
}

export async function sessionUser(db: pg.Pool, token: string): Promise<SessionUser | null> {
  if (!token) return null;
  const r = await db.query(`UPDATE sessions s SET last_seen = now() FROM app_users u
    WHERE s.token_hash = $1 AND s.user_id = u.id AND s.ended_at IS NULL AND s.expires_at > now() AND u.active
    RETURNING u.id, u.email, u.display_name, u.role`, [sha(token)]);
  const u = r.rows[0];
  return u ? { id: u.id, email: u.email, displayName: u.display_name, role: u.role } : null;
}

export async function logout(db: pg.Pool, token: string) {
  await db.query("UPDATE sessions SET ended_at = now() WHERE token_hash = $1 AND ended_at IS NULL", [sha(token)]);
}
