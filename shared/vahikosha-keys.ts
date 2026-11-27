// Vahikosha keys: each business has its own key, and each person their own
// access to it. Everything here runs on the person's device (browser, the
// Windows app's WebView2, the Android app, or Node); the server only ever
// stores what these functions put out, and none of it opens anything without
// a secret the server never sees.
//
//   business key   64 random bytes: AES-256 key | HMAC-SHA256 key. Records are
//                  sealed with it in the same format the apps use today
//                  ("enc" = iv | AES-256-CBC(deflate(JSON)) | HMAC), so the
//                  Windows app's Crypto class reads them as before.
//   person key     an ECDH P-256 key pair per person. The private half is kept
//                  on the server only sealed with the person's own passphrase
//                  (PBKDF2-SHA256), so a new device can unlock it.
//   envelope       the business key locked for one person (or for the
//                  business's recovery code): ECDH with a one-time key, HKDF,
//                  AES-256-GCM. A removed person's envelope is withdrawn and
//                  the owner makes a new key version for the others.
//   recovery code  a long random code shown once to the owner. It is a
//                  "person" too: its private half is sealed with the code, and
//                  every key version gets an envelope for it.

const te = new TextEncoder(), td = new TextDecoder();
const subtle = globalThis.crypto.subtle;
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export const PASS_ITERATIONS = 600_000;

export function b64(u: Uint8Array) {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string) {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const buf = (u: Uint8Array) => u as BufferSource;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

// ---------------------------------------------------------------- sealing (the apps' existing format)

interface SealKeys { aes: CryptoKey; mac: CryptoKey }

async function sealKeys(raw64: Uint8Array): Promise<SealKeys> {
  if (raw64.length !== 64) throw new Error("A key must be 64 bytes");
  return {
    aes: await subtle.importKey("raw", buf(raw64.slice(0, 32)), { name: "AES-CBC" }, false, ["encrypt", "decrypt"]),
    mac: await subtle.importKey("raw", buf(raw64.slice(32, 64)), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  };
}

async function seal(k: SealKeys, value: unknown) {
  const z = await pipe(te.encode(JSON.stringify(value)), new CompressionStream("deflate-raw"));
  const iv = random(16);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv }, k.aes, buf(z)));
  const body = new Uint8Array(16 + ct.length);
  body.set(iv); body.set(ct, 16);
  const mac = new Uint8Array(await subtle.sign("HMAC", k.mac, body));
  const all = new Uint8Array(body.length + 32);
  all.set(body); all.set(mac, body.length);
  return b64(all);
}

async function open(k: SealKeys, s: string) {
  const all = unb64(s);
  if (all.length < 16 + 16 + 32) throw new Error("Damaged sealed data.");
  const body = all.subarray(0, all.length - 32), mac = all.subarray(all.length - 32);
  if (!(await subtle.verify("HMAC", k.mac, buf(mac), buf(body)))) throw new Error("Wrong key, or the data was changed.");
  const z = new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: buf(body.subarray(0, 16)) }, k.aes, buf(body.subarray(16))));
  return JSON.parse(td.decode(await pipe(z, new DecompressionStream("deflate-raw"))));
}

// 64 bytes from a passphrase (the same derivation the apps use for the old team passphrase)
async function fromPassphrase(pass: string, salt: Uint8Array, iter: number) {
  const base = await subtle.importKey("raw", te.encode(pass), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: buf(salt), iterations: iter }, base, 512));
}

// ---------------------------------------------------------------- the business key

export interface BusinessKey { version: number; raw: Uint8Array }

export function newBusinessKey(version: number): BusinessKey {
  return { version, raw: random(64) };
}

// a value the server keeps per key version, so a device can tell it unlocked the right key
// (an HMAC of a fixed text: it says nothing about the key itself)
export async function keyCheck(key: BusinessKey) {
  const k = await sealKeys(key.raw);
  return b64(new Uint8Array(await subtle.sign("HMAC", k.mac, te.encode("vahikosha-key-check|" + key.version))));
}

export async function sealRecord(key: BusinessKey, value: unknown) {
  return seal(await sealKeys(key.raw), value);
}
export async function openRecord(key: BusinessKey, sealed: string) {
  return open(await sealKeys(key.raw), sealed);
}

// ---------------------------------------------------------------- a person's key pair

// what the server keeps for a person (or for a business's recovery code)
export interface PersonKeyRecord { publicKey: string; privateSealed: string; salt: string; iter: number }

export async function newPersonKey(passphrase: string, iter = PASS_ITERATIONS): Promise<PersonKeyRecord> {
  if (passphrase.length < 8) throw new Error("The passphrase needs at least 8 characters.");
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const priv = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const salt = random(16);
  const privateSealed = await seal(await sealKeys(await fromPassphrase(passphrase, salt, iter)), { pkcs8: b64(priv), pub: b64(pub) });
  return { publicKey: b64(pub), privateSealed, salt: b64(salt), iter };
}

// the private key, opened with the passphrase (null when the passphrase is wrong)
export async function unlockPersonKey(rec: PersonKeyRecord, passphrase: string): Promise<CryptoKey | null> {
  let v: { pkcs8: string; pub: string };
  try { v = await open(await sealKeys(await fromPassphrase(passphrase, unb64(rec.salt), rec.iter)), rec.privateSealed); }
  catch { return null; }
  if (v.pub !== rec.publicKey) return null;   // sealed for another key pair
  return subtle.importKey("pkcs8", buf(unb64(v.pkcs8)), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

// the same key pair under a new passphrase (the public half stays, so no envelope changes)
export async function changePassphrase(rec: PersonKeyRecord, oldPass: string, newPass: string, iter = PASS_ITERATIONS): Promise<PersonKeyRecord | null> {
  if (newPass.length < 8) throw new Error("The passphrase needs at least 8 characters.");
  let v: { pkcs8: string; pub: string };
  try { v = await open(await sealKeys(await fromPassphrase(oldPass, unb64(rec.salt), rec.iter)), rec.privateSealed); }
  catch { return null; }
  const salt = random(16);
  return { publicKey: rec.publicKey, privateSealed: await seal(await sealKeys(await fromPassphrase(newPass, salt, iter)), v), salt: b64(salt), iter };
}

// ---------------------------------------------------------------- envelopes

// what an envelope is bound to: it only opens for this business, key version and holder
export interface EnvelopeFor { business: string; version: number; holder: string }
const info = (f: EnvelopeFor) => te.encode("vahikosha-envelope|v1|" + f.business + "|" + f.version + "|" + f.holder);

async function wrapKey(shared: Uint8Array, salt: Uint8Array, f: EnvelopeFor) {
  const hk = await subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info(f)) }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// lock the business key for the holder of publicKey
export async function makeEnvelope(key: BusinessKey, publicKey: string, f: Omit<EnvelopeFor, "version">): Promise<string> {
  const ff = { ...f, version: key.version };
  const them = await subtle.importKey("spki", buf(unb64(publicKey)), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: them }, eph.privateKey, 256));
  const salt = random(16), iv = random(12);
  const k = await wrapKey(shared, salt, ff);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(info(ff)) }, k, buf(key.raw)));
  const epk = new Uint8Array(await subtle.exportKey("spki", eph.publicKey));
  return JSON.stringify({ v: 1, epk: b64(epk), salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

// open an envelope with the holder's private key (null if it isn't theirs or was changed)
export async function openEnvelope(envelope: string, privateKey: CryptoKey, f: EnvelopeFor): Promise<BusinessKey | null> {
  try {
    const e = JSON.parse(envelope) as { v: number; epk: string; salt: string; iv: string; ct: string };
    if (e.v !== 1) return null;
    const epk = await subtle.importKey("spki", buf(unb64(e.epk)), { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: epk }, privateKey, 256));
    const k = await wrapKey(shared, unb64(e.salt), f);
    const raw = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: buf(unb64(e.iv)), additionalData: buf(info(f)) }, k, buf(unb64(e.ct))));
    return raw.length === 64 ? { version: f.version, raw } : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- recovery code

const B32 = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // no 0/O, 1/I/L: easy to read out and type

// 24 characters in groups of four (about 119 bits), e.g. "K7QM-2XPA-…"
export function newRecoveryCode() {
  const r = random(24);
  const s = Array.from(r, (x) => B32[x % B32.length]).join("");
  return s.match(/.{4}/g)!.join("-");
}
// typed by hand: ignore spaces, dashes and case
export const normaliseCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "").match(/.{1,4}/g)?.join("-") || "";

// the recovery code's key pair: kept like a person's, sealed with the code
export const newRecoveryKey = (code: string, iter = PASS_ITERATIONS) => newPersonKey(normaliseCode(code), iter);
export const unlockRecoveryKey = (rec: PersonKeyRecord, code: string) => unlockPersonKey(rec, normaliseCode(code));

// the holder name used for the recovery code's envelopes
export const RECOVERY = "recovery";
