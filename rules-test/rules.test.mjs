// Tests for firestore.rules, run in the Firebase emulator (nothing touches the
// real project). Run: npm test  (in this folder; needs Java)
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, Timestamp } from "firebase/firestore";

let env;
const enc = (n = Math.random()) => ({ enc: "sealed-" + n });
const past = Timestamp.fromMillis(Date.now() - 86400e3);
const future = Timestamp.fromMillis(Date.now() + 86400e3);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "vahikosha-rules-test",
    firestore: { rules: readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8181 },
  });
});
after(() => env.cleanup());

// workspace "a" (owner oA) and "b" (owner oB) with one member of every kind
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    const m = (w, uid, d) => setDoc(doc(db, `workspaces/${w}/members/${uid}`), d);
    await setDoc(doc(db, "workspaces/a"), { name: "A", ownerUid: "oA", status: "trial" });
    await setDoc(doc(db, "workspaces/b"), { name: "B", ownerUid: "oB", status: "trial" });
    await m("a", "oA", { role: "owner" });
    await m("b", "oB", { role: "owner" });
    await m("a", "acc", { role: "accountant", canApprove: false });
    await m("a", "accOk", { role: "accountant", canApprove: true });
    await m("a", "staff", { role: "staff" });
    await m("a", "ca", { role: "ca", until: future });
    await m("a", "caOld", { role: "ca", until: past });
    await m("a", "gone", { role: "staff", removedAt: past });
    await setDoc(doc(db, "workspaces/a/customers/c1"), enc(1));
    await setDoc(doc(db, "workspaces/a/messages/m1"), enc(1));
    await setDoc(doc(db, "workspaces/a/devices/dStaff"), { uid: "staff", name: "phone" });
    await setDoc(doc(db, "workspaces/a/keys/dStaff"), { kv: 1, wrapped: "x" });
    await setDoc(doc(db, "workspaces/b/customers/c1"), enc(1));
    await setDoc(doc(db, "customers/old1"), { name: "old" });
  });
});

const as = (uid, email) => env.authenticatedContext(uid, email ? { email } : {}).firestore();
const anon = () => env.unauthenticatedContext().firestore();

/* ---- today's paths are unchanged ---- */
test("old paths: the listed login still gets in, others don't", async () => {
  await assertSucceeds(getDoc(doc(as("t", "tarunchettam12@gmail.com"), "customers/old1")));
  await assertFails(getDoc(doc(as("x", "someone@else.com"), "customers/old1")));
  await assertFails(getDoc(doc(as("oA"), "customers/old1")));
});

/* ---- creating a workspace ---- */
test("create: workspace and owner entry together, on a trial", async () => {
  const db = as("new");
  const b = writeBatch(db);
  b.set(doc(db, "workspaces/n"), { name: "N", ownerUid: "new", status: "trial" });
  b.set(doc(db, "workspaces/n/members/new"), { role: "owner" });
  await assertSucceeds(b.commit());
});
test("create: refused without the owner entry, as someone else, paid, or with a plan", async () => {
  const db = as("new");
  await assertFails(setDoc(doc(db, "workspaces/n"), { name: "N", ownerUid: "new", status: "trial" }));
  for (const ws of [{ ownerUid: "other", status: "trial" }, { ownerUid: "new", status: "active" }, { ownerUid: "new", status: "trial", plan: "pro" }]) {
    const b = writeBatch(db);
    b.set(doc(db, "workspaces/n"), { name: "N", ...ws });
    b.set(doc(db, "workspaces/n/members/new"), { role: "owner" });
    await assertFails(b.commit());
  }
});
test("create: nobody can make themselves owner of an existing workspace", async () => {
  await assertFails(setDoc(doc(as("x"), "workspaces/a/members/x"), { role: "owner" }));
  await assertFails(setDoc(doc(as("x"), "workspaces/a/members/x"), { role: "staff" }));
});
test("workspace: owner renames; ownerUid, status and plan never change from an app", async () => {
  const db = as("oA");
  await assertSucceeds(updateDoc(doc(db, "workspaces/a"), { name: "A2" }));
  await assertFails(updateDoc(doc(db, "workspaces/a"), { ownerUid: "x" }));
  await assertFails(updateDoc(doc(db, "workspaces/a"), { status: "active" }));
  await assertFails(updateDoc(doc(db, "workspaces/a"), { plan: "pro" }));
  await assertFails(updateDoc(doc(as("acc"), "workspaces/a"), { name: "A3" }));
  await assertFails(deleteDoc(doc(db, "workspaces/a")));
});

/* ---- who can read ---- */
test("read: members only, and never another business", async () => {
  for (const u of ["oA", "acc", "staff", "ca"]) await assertSucceeds(getDoc(doc(as(u), "workspaces/a/customers/c1")));
  await assertFails(getDoc(doc(as("oB"), "workspaces/a/customers/c1")));
  await assertFails(getDoc(doc(as("oA"), "workspaces/b/customers/c1")));
  await assertFails(getDoc(doc(as("x"), "workspaces/a")));
  await assertFails(getDoc(doc(anon(), "workspaces/a/customers/c1")));
});
test("read: a removed member, or a CA past the end date, is out", async () => {
  await assertFails(getDoc(doc(as("gone"), "workspaces/a/customers/c1")));
  await assertFails(getDoc(doc(as("caOld"), "workspaces/a/customers/c1")));
});

/* ---- who can write what ---- */
test("write: owner and accountant write any record, always encrypted, never deleted", async () => {
  for (const u of ["oA", "acc"]) {
    const db = as(u);
    await assertSucceeds(setDoc(doc(db, "workspaces/a/customers/c1"), enc()));
    await assertSucceeds(setDoc(doc(db, "workspaces/a/settings/s"), enc()));
    await assertSucceeds(setDoc(doc(db, "workspaces/a/tallyBills/t" + u), enc()));
    await assertFails(setDoc(doc(db, "workspaces/a/customers/c2"), { name: "plain" }));
    await assertFails(deleteDoc(doc(db, "workspaces/a/customers/c1")));
  }
});
test("write: the same 'enc' again is refused (a readable write beside the old one)", async () => {
  await assertFails(setDoc(doc(as("oA"), "workspaces/a/customers/c1"), { ...enc(1), name: "plain" }));
});
test("write: only known collections", async () => {
  await assertFails(setDoc(doc(as("oA"), "workspaces/a/anything/x"), enc()));
});
test("write: staff only on day-to-day screens", async () => {
  const db = as("staff");
  for (const c of ["orders", "receipts", "services", "transports", "messages"]) await assertSucceeds(setDoc(doc(db, `workspaces/a/${c}/s1`), enc()));
  for (const c of ["customers", "products", "settings", "balances", "tallyBills"]) await assertFails(setDoc(doc(db, `workspaces/a/${c}/s1`), enc()));
});
test("write: an Outside CA can't change anything", async () => {
  await assertFails(setDoc(doc(as("ca"), "workspaces/a/orders/x"), enc()));
  await assertFails(setDoc(doc(as("ca"), "workspaces/a/activity/x"), { ...enc(), by: "ca" }));
});
test("messages: added to, never changed", async () => {
  await assertFails(setDoc(doc(as("oA"), "workspaces/a/messages/m1"), enc()));
});
test("history: added by the person themselves only, never changed", async () => {
  const db = as("staff", "s@x.in");
  await assertSucceeds(setDoc(doc(db, "workspaces/a/activity/h1"), { ...enc(), by: "staff" }));
  await assertSucceeds(setDoc(doc(db, "workspaces/a/activity/h2"), { ...enc(), by: "s@x.in" }));
  await assertFails(setDoc(doc(db, "workspaces/a/activity/h3"), { ...enc(), by: "oA" }));
  await assertFails(setDoc(doc(db, "workspaces/a/activity/h1"), { ...enc(), by: "staff" }));
});

/* ---- people ---- */
test("people: owner adds and changes members; staff can't", async () => {
  await assertSucceeds(setDoc(doc(as("oA"), "workspaces/a/members/p1"), { role: "staff" }));
  await assertFails(setDoc(doc(as("staff"), "workspaces/a/members/p2"), { role: "staff" }));
  await assertFails(setDoc(doc(as("acc"), "workspaces/a/members/p2"), { role: "staff" }));
  // once the owner allows it, the accountant can add people
  await assertSucceeds(updateDoc(doc(as("oA"), "workspaces/a/members/acc"), { canApprove: true }));
  await assertSucceeds(setDoc(doc(as("acc"), "workspaces/a/members/p2"), { role: "staff" }));
});
test("people: an approving accountant adds staff, but no owner and no approvers", async () => {
  const db = as("accOk");
  await assertSucceeds(setDoc(doc(db, "workspaces/a/members/p3"), { role: "staff" }));
  await assertFails(setDoc(doc(db, "workspaces/a/members/p4"), { role: "owner" }));
  await assertFails(updateDoc(doc(db, "workspaces/a/members/acc"), { canApprove: true }));
  await assertFails(updateDoc(doc(db, "workspaces/a/members/oA"), { role: "staff" }));
});
test("people: one owner; a removal can't be undone; nobody is deleted", async () => {
  const db = as("oA");
  await assertFails(setDoc(doc(db, "workspaces/a/members/p5"), { role: "owner" }));
  await assertFails(updateDoc(doc(db, "workspaces/a/members/oA"), { role: "staff" }));
  await assertFails(updateDoc(doc(db, "workspaces/a/members/staff"), { role: "owner" }));
  await assertSucceeds(updateDoc(doc(db, "workspaces/a/members/staff"), { removedAt: past }));
  await assertFails(setDoc(doc(db, "workspaces/a/members/gone"), { role: "staff" }));
  await assertFails(deleteDoc(doc(db, "workspaces/a/members/acc")));
});

/* ---- devices and keys ---- */
test("devices: a member adds their own; only an approver approves or logs out; logout is final", async () => {
  const s = as("staff");
  await assertSucceeds(setDoc(doc(s, "workspaces/a/devices/d2"), { uid: "staff", name: "pc" }));
  await assertFails(setDoc(doc(s, "workspaces/a/devices/d3"), { uid: "oA", name: "pc" }));
  await assertFails(setDoc(doc(s, "workspaces/a/devices/d4"), { uid: "staff", approvedBy: "staff" }));
  await assertSucceeds(updateDoc(doc(s, "workspaces/a/devices/d2"), { lastSeen: 1 }));
  await assertFails(updateDoc(doc(s, "workspaces/a/devices/d2"), { approvedBy: "staff" }));
  await assertSucceeds(updateDoc(doc(as("oA"), "workspaces/a/devices/d2"), { approvedBy: "oA" }));
  await assertSucceeds(updateDoc(doc(as("accOk"), "workspaces/a/devices/d2"), { revokedAt: 5 }));
  await assertFails(updateDoc(doc(as("oA"), "workspaces/a/devices/d2"), { revokedAt: 6 }));
  await assertFails(deleteDoc(doc(as("oA"), "workspaces/a/devices/d2")));
});
test("keys: only that device's person reads its wrapped key; approvers write", async () => {
  await assertSucceeds(getDoc(doc(as("staff"), "workspaces/a/keys/dStaff")));
  await assertFails(getDoc(doc(as("oA"), "workspaces/a/keys/dStaff")));
  await assertSucceeds(setDoc(doc(as("accOk"), "workspaces/a/keys/dStaff"), { kv: 2, wrapped: "y" }));
  await assertFails(setDoc(doc(as("staff"), "workspaces/a/keys/dStaff"), { kv: 2, wrapped: "z" }));
});
test("recovery: members read, only the owner writes", async () => {
  await assertSucceeds(setDoc(doc(as("oA"), "workspaces/a/recovery/current"), { kv: 1, wrapped: "w" }));
  await assertSucceeds(getDoc(doc(as("staff"), "workspaces/a/recovery/current")));
  await assertFails(setDoc(doc(as("accOk"), "workspaces/a/recovery/current"), { kv: 2, wrapped: "w" }));
});
test("pairing: closed until QR pairing is built", async () => {
  await assertFails(setDoc(doc(as("oA"), "workspaces/a/pairing/123"), { x: 1 }));
});
test("users: each person reads and writes only their own list", async () => {
  await assertSucceeds(setDoc(doc(as("oA"), "users/oA"), { workspaces: ["a"] }));
  await assertFails(getDoc(doc(as("oB"), "users/oA")));
  await assertFails(deleteDoc(doc(as("oA"), "users/oA")));
});
