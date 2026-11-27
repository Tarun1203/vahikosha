// Devices signed in: every phone, PC and Windows app using the app, when it was
// last seen, and "Log out" to sign one out and wipe it (e.g. a lost phone).
// Logged-out devices stay in the list (nothing is deleted).
import { useEffect, useState } from "react";
import { IconDeviceMobile, IconDeviceDesktop, IconLogout, IconPencil } from "@tabler/icons-react";
import { Button, Card, EmptyState, PageHeader, useToast } from "@/components/kit";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/data";
import { listenDevices, logoutDevice, renameDevice, thisDevice, type Device } from "@/lib/devices";
import { cn } from "@/lib/utils";

const when = (t?: { toDate: () => Date } | null) => {
  if (!t) return "";
  const d = t.toDate(), mins = Math.round((Date.now() - d.getTime()) / 60e3);
  if (mins < 2) return "online now";
  if (mins < 60) return mins + " min ago";
  if (mins < 24 * 60) return Math.round(mins / 60) + " h ago";
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

export function Devices() {
  const { user } = useStore();
  const toast = useToast();
  const [list, setList] = useState<Device[] | null>(null);
  const [err, setErr] = useState("");
  const me = thisDevice().id;
  useEffect(() => {
    // local development only: ?demo shows sample devices
    if (import.meta.env.DEV && new URLSearchParams(location.search).has("demo")) { import("@/lib/demo").then((d) => setList(d.demoDevices(me))); return; }
    if (!user) return;
    return listenDevices(setList, (e) => setErr(/permission/i.test(e.message) ? "The database rules for devices aren't published yet — publish firestore.rules in the Firebase console." : e.message));
  }, [user]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function logout(d: Device) {
    const self = d.id === me;
    if (!window.confirm((self ? "Log out THIS device" : "Log out " + (d.name || d.label)) + " (" + d.email + ")?\n\n" +
      "It signs out and wipes what it keeps — the saved passphrase and its offline copy of the data — as soon as it is online. " +
      "Anything it saved while offline and hasn't uploaded yet is lost.\n\nFor a lost or stolen phone, also change that login's password in the Firebase console.")) return;
    try {
      // History only once the logout is saved — except for this device, which reloads as soon as it is
      const entry = { name: d.name || d.label, device: d.id, email: d.email, app: d.app };
      if (self) await logEvent("device-logged-out", entry);
      await logoutDevice(d.id, user?.email || "");
      if (!self) await logEvent("device-logged-out", entry);
      toast(self ? "Logging out this device…" : "Logged out. It signs out the next time it is online.");
    } catch (e) { toast("Couldn't log it out: " + (e as Error).message); }
  }
  async function rename(d: Device) {
    const name = window.prompt("Name for this device (e.g. Raju's phone, Office PC):", d.name || d.label);
    if (name === null || !name.trim() || name.trim() === d.name) return;
    try { await renameDevice(d.id, name); await logEvent("device-renamed", { name: name.trim(), device: d.id, before: d.name || d.label }); }
    catch (e) { toast("Couldn't rename it: " + (e as Error).message); }
  }

  const rows = (list || []).slice().sort((a, b) => Number(!!a.revokedAt) - Number(!!b.revokedAt) || (b.lastSeen?.toMillis?.() || 0) - (a.lastSeen?.toMillis?.() || 0));
  return (
    <div>
      <PageHeader icon="setting" eyebrow="Settings" title="Devices signed in"
        subtitle="Every phone, PC and Windows app using Chittam. Log one out to sign it out and wipe its saved data — for a lost phone, also change that login's password." />
      {err && <Card className="mb-4 border-rose-200 bg-rose-50 text-sm text-rose-800">{err}</Card>}
      {list === null && !err ? <p className="text-sm text-neutral-500">Loading…</p>
        : !rows.length ? <EmptyState icon="setting" title="No devices yet" text="Devices appear here once they open the updated app." />
        : (
          <Card className="divide-y divide-neutral-100 p-0">
            {rows.map((d) => {
              const phone = /phone|android|iphone|ipad|tablet/i.test(d.label), off = !!d.revokedAt;
              return (
                <div key={d.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3 text-sm", off && "opacity-60")}>
                  <span className="text-neutral-400">{phone ? <IconDeviceMobile size={22} /> : <IconDeviceDesktop size={22} />}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{d.name || d.label}</span>
                      {d.id === me && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">This device</span>}
                      {off && <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-bold text-neutral-600">Logged out</span>}
                    </div>
                    <p className="text-xs text-neutral-500">{[d.name ? d.label : "", d.app, d.version ? "v" + d.version : "", d.email].filter(Boolean).join(" · ")}</p>
                    <p className="text-xs text-neutral-500">{off ? "Logged out " + when(d.revokedAt) + (d.revokedBy ? " by " + d.revokedBy : "") : "Last seen " + (when(d.lastSeen) || "—")}</p>
                  </div>
                  {!off && <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => rename(d)}><IconPencil size={15} /> Name</Button>
                    <Button size="sm" variant="secondary" onClick={() => logout(d)}><IconLogout size={15} /> Log out</Button>
                  </div>}
                </div>
              );
            })}
          </Card>
        )}
    </div>
  );
}
