// The relay: the only file that talks to the cloud (today Firebase:
// Firestore and Auth). Every other file reads and writes through these
// functions, by collection name and record id.
//
// Why: the workspace paths (workspaces/{wid}/…) and a later move to Supabase
// or a self-hosted PostgreSQL then change this one file, not the pages.
// See docs/design-multi-customer-sync.md, work package 1. This version does
// exactly what the app did before: same collections, same fields.
import {
  addDoc, collection, doc, getDocs, limit, onSnapshot, orderBy, query, runTransaction, serverTimestamp, setDoc, writeBatch,
  type DocumentData, type DocumentReference, type Timestamp,
} from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut, type User } from "firebase/auth";
import { auth, db } from "./firebase";

export type { DocumentData, Timestamp, User };
export interface Doc { id: string; data: DocumentData }
type Unsub = () => void;

// where a record lives (the one place the workspace prefix will be added)
const ref = (coll: string, id: string) => doc(db, coll, id);
const coll = (name: string) => collection(db, name);

// "the time on the server when this reached it"
export const serverTime = () => serverTimestamp();

/* ---------------- reading ---------------- */

// every record of a collection, live; fromCache: what this device holds offline, not yet confirmed
// cacheChanges: also call back when only that offline/confirmed state changes
export function listenAll(name: string, cb: (docs: Doc[], fromCache: boolean) => void, onError?: (e: Error) => void, opts: { cacheChanges?: boolean } = {}): Unsub {
  return onSnapshot(coll(name), { includeMetadataChanges: !!opts.cacheChanges },
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, data: d.data() })), snap.metadata.fromCache), onError);
}

// one record, live (null when it doesn't exist)
export function listenOne(name: string, id: string, cb: (data: DocumentData | null) => void, onError?: (e: Error) => void): Unsub {
  return onSnapshot(ref(name, id), (d) => cb(d.exists() ? d.data() : null), onError);
}

// every record of a collection, once
export async function readAll(name: string): Promise<Doc[]> {
  const snap = await getDocs(coll(name));
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

// the newest records of a collection by a time field, newest first
export async function readLatest(name: string, field: string, count: number): Promise<Doc[]> {
  const snap = await getDocs(query(coll(name), orderBy(field, "desc"), limit(count)));
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

/* ---------------- writing (never deleting: there is no delete here) ---------------- */

export async function write(name: string, id: string, data: DocumentData, opts: { merge?: boolean } = {}) {
  await setDoc(ref(name, id), data, { merge: !!opts.merge });
}

// a new record with a new id; returns the id
export async function add(name: string, data: DocumentData) {
  return (await addDoc(coll(name), data)).id;
}

// several writes that are saved together or not at all
export interface Batch {
  newId(name: string): string;
  set(name: string, id: string, data: DocumentData, opts?: { merge?: boolean }): void;
  add(name: string, data: DocumentData): string;
  commit(): Promise<void>;
}
export function batch(): Batch {
  const b = writeBatch(db);
  return {
    newId: (name) => doc(coll(name)).id,
    set: (name, id, data, opts = {}) => { b.set(ref(name, id), data, { merge: !!opts.merge }); },
    add: (name, data) => { const r: DocumentReference = doc(coll(name)); b.set(r, data); return r.id; },
    commit: () => b.commit(),
  };
}

// read one record and write it back in one step (fails if someone changed it meanwhile)
export async function update(name: string, id: string, fn: (current: DocumentData | null) => DocumentData) {
  const r = ref(name, id);
  await runTransaction(db, async (tx) => {
    const cur = await tx.get(r);
    tx.set(r, fn(cur.exists() ? cur.data() : null));
  });
}

/* ---------------- signing in ---------------- */

export const currentUser = () => auth.currentUser;
export const onUser = (cb: (u: User | null) => void): Unsub => onAuthStateChanged(auth, cb);
export const signIn = async (email: string, password: string) => { await signInWithEmailAndPassword(auth, email, password); };
export const signOut = () => fbSignOut(auth);

// which cloud project this is (shown in Settings)
export { firebaseProjectId as cloudProject } from "./firebase";
