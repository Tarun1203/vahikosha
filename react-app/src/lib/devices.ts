// Devices signed in: every phone, PC and Windows app that opens the app records
// itself in devices/{id} (a random id kept on the device, shared by the old and
// the new app). The list shows them all; "Log out" marks one, and that device
// signs out and wipes what it keeps (saved passphrase key, offline copy of the
// data) the next time it is online. The records stay readable (not encrypted)
// so a device without the passphrase can still see that it was logged out.
//
// Limit: this is obeyed by the app itself. A phone that is offline logs out
// when it comes back online. To lock a lost phone out for certain, also change
// that login's password in the Firebase console.
import { listenAll, listenOne, serverTime, signOut, write, type Timestamp, type User } from "./relay";
import { APP_VERSION } from "@/version";

export interface Device {
  id: string; name?: string; label: string; app: string; version: string; email: string;
  firstSeen: string; lastSeen?: Timestamp | null; revokedAt?: Timestamp | null; revokedBy?: string;
}

const KEY = "cem_device";
// this device's id and when it was first seen (the old app uses the same key)
export function thisDevice(): { id: string; firstSeen: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved?.id) return saved;
  } catch { /* new id below */ }
  const d = { id: "dev_" + crypto.randomUUID(), firstSeen: new Date().toISOString() };
  try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* kept for this visit only */ }
  return d;
}

// "Android phone · Chrome", "Windows PC · Edge"…
export function deviceLabel() {
  const ua = navigator.userAgent;
  const kind = /Android/i.test(ua) ? (/Mobile/i.test(ua) ? "Android phone" : "Android tablet")
    : /iPhone/i.test(ua) ? "iPhone" : /iPad/i.test(ua) ? "iPad" : /Windows/i.test(ua) ? "Windows PC" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux PC" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return kind + (browser ? " · " + browser : "");
}
const appName = () => {
  const w = window as unknown as { chittamDesktop?: unknown };
  if (w.chittamDesktop) return "Windows app";
  if (document.referrer.startsWith("android-app://") || matchMedia("(display-mode: standalone)").matches) return "Installed app";
  return "Browser";
};

// wipes this device and reloads: the start of each app (index.html) finishes the
// job before anything opens the stored data again
export async function wipeThisDevice() {
  try { localStorage.setItem("cem_wipe", "1"); } catch { /* signed out below anyway */ }
  try { await signOut(); } catch { /* reload signs in fresh */ }
  location.reload();
}

// called once signed in: records this device, keeps "last seen" fresh, and
// signs out when it is logged out from another device
export function registerDevice(user: User) {
  const me = thisDevice();
  const beat = () => write("devices", me.id, {
    label: deviceLabel(), app: appName() + " (new)", version: APP_VERSION, email: user.email || "",
    firstSeen: me.firstSeen, lastSeen: serverTime(),
  }, { merge: true }).catch(() => { /* offline: next beat */ });
  beat();
  const timer = setInterval(() => { if (document.visibilityState === "visible") beat(); }, 15 * 60e3);
  const onVisible = () => { if (document.visibilityState === "visible") beat(); };
  document.addEventListener("visibilitychange", onVisible);
  const unsub = listenOne("devices", me.id, (d) => { if (d && d.revokedAt) wipeThisDevice(); }, () => { /* rules not published yet */ });
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); unsub(); };
}

export function listenDevices(cb: (list: Device[]) => void, onError?: (e: Error) => void) {
  return listenAll("devices", (docs) => cb(docs.map((d) => ({ id: d.id, ...d.data }) as Device)), onError);
}

export async function logoutDevice(id: string, by: string) {
  await write("devices", id, { revokedAt: serverTime(), revokedBy: by }, { merge: true });
}
export async function renameDevice(id: string, name: string) {
  await write("devices", id, { name: name.trim().slice(0, 60) }, { merge: true });
}
