// One-time move to PostgreSQL (local copy of the app only — not in the live build).
// Reads every Firebase collection with the signed-in user's own access and sends
// it to the local Chittam server on this PC, which saves it as a backup file.
// Nothing in Firebase is changed.
import { useState } from "react";
import { collection, getDocs, Timestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { Button, Card, PageHeader } from "@/components/kit";

const COLLECTIONS = ["customers", "products", "transports", "orders", "services", "receipts", "messages", "settings", "activity",
  "balances", "tallyVouchers", "tallyStock", "tallyBills"];
const SERVER = "http://127.0.0.1:8484";

// Firebase timestamps → { __ts: ISO } so the type isn't lost
function plain(v: unknown): unknown {
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, plain(x)]));
  return v;
}

export default function ExportFirebase() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const say = (s: string) => setLog((l) => [...l, s]);

  async function run() {
    setBusy(true); setLog([]);
    try {
      const h = await fetch(SERVER + "/api/health").then((r) => r.json()).catch(() => null);
      if (!h?.ok) throw new Error("The Chittam server on this PC isn't running (" + SERVER + ").");
      say("Server on this PC: ok (" + h.migrations.length + " migrations)");
      const collections: Record<string, unknown[]> = {};
      for (const name of COLLECTIONS) {
        const snap = await getDocs(collection(db, name));
        collections[name] = snap.docs.map((d) => ({ ...(plain(d.data()) as object), id: d.id }));
        say(name + ": " + snap.size);
      }
      say("Sending to the server…");
      const res = await fetch(SERVER + "/api/import/firebase-snapshot", {
        method: "POST", headers: { "Content-Type": "application/json", "X-User": auth.currentUser?.email || "" },
        body: JSON.stringify({ exportedAt: new Date().toISOString(), by: auth.currentUser?.email || "", collections }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || "Server error " + res.status);
      say("Saved on this PC: " + out.file);
      say("Done. Nothing in Firebase was changed.");
    } catch (e) { say("Stopped: " + (e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader icon="notebook" eyebrow="PostgreSQL move" title="Copy data from Firebase" subtitle="Reads every collection with your sign-in and saves it on this PC for the PostgreSQL import. Firebase is not changed." />
      <Card className="space-y-4">
        <p className="text-sm">Signed in as <b>{auth.currentUser?.email || "—"}</b></p>
        <Button onClick={run} disabled={busy || !auth.currentUser}>{busy ? "Copying…" : "Copy all data to this PC"}</Button>
        {log.length > 0 && <pre className="max-h-96 overflow-auto rounded-xl bg-neutral-50 p-3 text-xs leading-relaxed">{log.join("\n")}</pre>}
      </Card>
    </div>
  );
}
