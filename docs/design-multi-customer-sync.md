# Vahikosha: multi-customer sync design

Status: **draft for owner approval**. No code has been written for it yet.
Date: 2026-11-27.

## Summary

Every customer installs Vahikosha and gets their own **workspace**, which the app creates by itself. Nothing is configured by hand on any phone or PC, and there is no VPN, no tunnel and no static IP.

Firebase (Firestore) remains the shared hub that every device connects to. All business data is encrypted on the device before it is uploaded, so Google, other customers and the Vahikosha operator see only scrambled data.

The office PC keeps a full local copy in PostgreSQL. It uses this copy for Tally, reports and backups.

Phones keep working when they are offline or when the office PC is switched off. Firestore's offline cache holds their changes and sends them, in order, when the connection comes back.

The data is stored so that the hub can later move to Supabase (or a self-hosted PostgreSQL) by replacing one file in each app.

## Goals

- **No setup per customer.** Install the app, sign in with Google, and the workspace is ready. Phones join by scanning a QR code.
- **Each customer's data is separate.** No customer can read another's data, and the operator can't either.
- **Readable data only on the business's own devices.** Data can be read only on the business's office PC and on the phones and PCs it has paired. The cloud holds only scrambled data.
- **Works offline.** If the office PC is off or the internet is down, phones still read and write. Everything syncs later, with nothing lost.
- **No deletes, everything logged.** These are the existing rules and they stay.
- **Can move to Supabase later** without changing screens, encryption or the PC code.

## Out of scope

- The full Control Center: support tools and operator reports. Only these are in scope:
  - the automatic trial and purchase;
  - the support reset;
  - PAN checks.
- Billing or accounting features. The app stays a tool for sharing and maintaining data.
- The Windows 7 legacy client.

## Decisions that change earlier chat answers

- **The cipher stays as it is.** Earlier I said AES-256-GCM. The app already uses **AES-256-CBC + HMAC-SHA256, encrypt-then-MAC**, with PBKDF2-SHA256 at 310,000 iterations. All three clients implement it the same way: `react-app/src/lib/crypto.ts`, `js/00-crypto.js` and the Windows `Crypto` class. It is secure. Switching to GCM would mean rewriting the C# and the old JavaScript with no gain in safety. We keep this format.
- **The key model changes.** Today the passphrase itself derives the data key. The new model uses a random workspace **data key**. The passphrase becomes the **recovery key** that unlocks it (see "Keys").
- **The office PC is not the hub.** The earlier plan had phones syncing with the PostgreSQL server on the office PC. That needs Tailscale or a tunnel, and you have ruled those out. Firebase is the hub instead, and the PC is one device among the others.

## Architecture

```
   Phone (Android / web)     Other PC (Windows app)     Office PC (Windows app + Tally)
   Firestore offline cache   Firestore offline cache    Firestore + PostgreSQL copy
           \                         |                          /
            \__________ encrypted records only ______________/
                                     |
                 Firebase (Firestore + Auth), region asia-south1
                 workspaces/{wid}/...   rules: members only
```

- **Firebase is the single source of truth.** It holds every record, encrypted.
- **The office PC's PostgreSQL is a local copy**, not a second master. The Windows app opens records with the workspace key and writes them to PostgreSQL. Reports and backups use that copy. It has the same role as `server/src/firebase-copy.ts` on branch `postgres-move`.
- **Tally data** (balances, bills, stock, transactions) continues to go from the Windows app to Firebase, encrypted the same way.
- **There is no direct link between phone and PC.** Because of that, the office PC being off does not affect phones.

## Data layout in Firestore

```
workspaces/{wid}                       { name, ownerUid, createdAt, status, kv }
workspaces/{wid}/members/{uid}         { role: "owner" | "accountant" | "staff" | "ca", canApprove, until?, email, addedAt, addedBy }
workspaces/{wid}/devices/{deviceId}    { name, uid, publicKey, addedAt, approvedBy, lastSeen, revokedAt? }
workspaces/{wid}/keys/{deviceId}       { kv, wrapped }      // the data key, wrapped for this one device
workspaces/{wid}/recovery              { kv, salt, iter, wrapped, check }
workspaces/{wid}/pairing/{code}        { ephemeralPub, expiresAt, phonePub?, phoneName?, approved? }
workspaces/{wid}/{collection}/{id}     { enc, kv, updatedAt, updatedBy }    // every business record
workspaces/{wid}/activity/{id}         { enc, kv, at, by }                  // history, append-only
users/{uid}                            { workspaces: [wid, ...] }           // which workspaces to show at sign-in
```

`{collection}` is the same set used today: customers, products, orders, receipts, services, transports, messages, balances, tallyBills, tallyStock, tallyVouchers and settings.

**Each record is one document holding one sealed field.** `sealDoc` already works this way. The only additions are `kv` (the key version) and the workspace path in front. No new outbox is needed, because Firestore's `persistentLocalCache` (already enabled in `react-app/src/lib/firebase.ts`) keeps offline writes and sends them in order.

**Why not an append-only change log instead?** A new device would have to replay every change ever made, and Firestore bills each read. Keeping one document per record means a new device reads the current state once. History stays in `activity`, as it does today.

### Mapping to Supabase later

| Firestore | Supabase / PostgreSQL |
|---|---|
| `workspaces/{wid}/{collection}/{id}` | table `records (workspace_id, coll, id, enc, kv, updated_at, updated_by)`, primary key `(workspace_id, coll, id)` |
| `members`, `devices`, `keys`, `pairing` | one table each, with a `workspace_id` column |
| rules: `isMember(wid)` | Row Level Security: `workspace_id in (select workspace_id from members where uid = auth.uid())` |
| live listeners | Supabase Realtime on `records` |

All cloud calls go through one file per client, called `relay` (`relay.ts` in the React app, a `Relay` class in C#, and the same in the old app). To move to Supabase, replace that file and copy the rows. The encryption stays the same and the keys stay on the devices, so nothing is re-encrypted.

## Keys

### The data key

- When a workspace is created, the office PC generates a random 32-byte **data key**. It is split into an AES key and an HMAC key, the same pair that `derive()` produces today, so `sealWith()` and `open` stay as they are.
- **The data key is never stored in the cloud in plain form.**
- On each device it is kept in local storage that can't be read from outside the app:
  - IndexedDB `chittam-crypto` for the web apps;
  - DPAPI for the Windows app, as the passphrase key is kept today.

## Roles

| Role | Business data | Settings | Approves devices and people | Notes |
|---|---|---|---|---|
| **Owner** | Read and write all | Yes | Yes | One per workspace. Can hand approval to an Accountant. |
| **Accountant** | Read and write all | Some | Only if the owner turns on `canApprove` | Its devices hold the data key, so it can pass the key to a new device. |
| **Staff** | Day-to-day screens (orders, receipts, jobs, messages) | No | No | |
| **Outside CA** | Read only | No | No | Access has an end date (`until`). When it ends, the CA is logged out and the key is changed. |
| **Chittam support** | **None** | No | No | Not a workspace member, and never gets the data key. Sees only name, plan, status, dates, device count and storage. |

- **Rules enforce the role on every write.** For example, staff can't write `settings`, and a CA can't write anything. The rules read the role from `members/{uid}`.
- **What the rules can't do:** a readable copy on a device can't be limited by role. A device either has the data key or it doesn't. So read-only means "can't change it", not "can't see it". Everyone paired can see all business data. If later some staff must not see some data (for example amounts), that data needs its own key. That is a later step.
- **Removing a member** works the same way as remote logout: the member is blocked, their devices are wiped, and the key is changed.

### Recovery key (the passphrase)

- The owner chooses a passphrase when the workspace is created. The app can suggest one and offer it for printing.
- PBKDF2(passphrase, salt, 310,000) gives a key that **wraps** the data key. The result is stored in `workspaces/{wid}/recovery`. The `check` field confirms a typed passphrase is right, the same way as today.
- A device that has the passphrase can always unwrap the data key. That covers recovery and replacing the office PC.
- **No one, including support, can decrypt the cloud data without the passphrase or a paired device.** This is the price of "no one else can read it".

### Support reset (lost passphrase and no working device)

The owner's decision: support may **reset** the workspace after checking the owner's ID. A reset gives no access to the old scrambled data. It starts a new key and refills the data from the business's own sources.

1. The owner asks support for a reset. Support checks the owner's PAN against the PAN given at registration, plus a call or video check.
2. Support starts the reset in the operator page. **A 72-hour wait follows.** Every owner and Accountant device gets an alert, and so does the owner's email. If someone else asked while posing as the owner, the real owner can cancel the reset from any working device.
3. After 72 hours, the following happens:
   1. The old devices are logged out, and the old keys are retired.
   2. The owner pairs a new office PC with a new data key and a new passphrase.
   3. The old scrambled records are left untouched, because there are no deletes. They stay unreadable for good.
4. **Refill:**
   - Tally data is read again from Tally.
   - Data that exists only in Vahikosha (orders, receipts, jobs, messages, customers' extra fields) comes back from the office PC's PostgreSQL copy, which is not scrambled.
5. Every reset is logged permanently, with who asked, who approved, when, and what ID was checked.

**Limit:** if the office PC (with its PostgreSQL copy) is also lost, data that existed only in Vahikosha cannot be recovered. Tally data still comes back from Tally or its backups. The Tally backup feature (Windows 3.9) and a backup of the PostgreSQL copy are therefore part of setup.

### Device keys

- Each device creates its own key pair (ECDH P-256) the first time it starts:
  - web: WebCrypto, with the private key set non-extractable and kept in IndexedDB;
  - Windows: `ECDiffieHellmanCng`, with the private key in the user's key store.
- The public key goes to `devices/{deviceId}`.
- The data key is wrapped **for each device separately** and stored in `keys/{deviceId}`. ECDH with the workspace's wrap key, then HKDF, then the existing AES-CBC + HMAC seal.
- This lets the key be changed later and handed only to the devices that remain (see "Remote logout").

## Flows

### 1. A new customer creates a workspace (office PC)

1. The customer installs the Windows app and signs in with Google.
2. The app checks `users/{uid}`. If it lists no workspace, the app shows **Start free trial** (see "Trial and purchase").
3. In **one batched write**, the app creates:
   - `workspaces/{wid}`, using an automatic ID;
   - `members/{uid}` with role owner;
   - its own `devices/{deviceId}`;
   - `keys/{deviceId}`;
   - `recovery`;
   - `users/{uid}`.

   The rules use `getAfter()` to check that the owner equals the signed-in user and that the owner's member document is part of the same batch.
4. The app shows the recovery key once and asks the owner to print or save it.
5. The app finds Tally and starts syncing, as the current Windows app does.

### 2. Adding a phone or another PC (QR pairing)

1. On the office PC (or any owner device), the owner opens **Devices → Add device**. The PC creates a one-time code and a temporary key pair, and writes `pairing/{code}` with the public half and an expiry 10 minutes ahead.
2. The PC shows a QR code containing `wid`, `code` and the temporary public key. **The QR code does not contain the data key**, so a photo or screenshot of it is useless after 10 minutes.
3. The new device signs in with Google, scans the QR code, creates its own device key pair, and writes its public key and name into `pairing/{code}`.
4. The owner sees *"Ramesh's phone wants to join"* on the PC and taps **Approve**. The PC then:
   - adds `members/{uid}` if this is a new person;
   - adds `devices/{deviceId}`;
   - writes `keys/{deviceId}` with the data key wrapped for that device's public key;
   - marks the pairing approved.
5. The phone unwraps the data key and starts syncing.
6. **Without a QR code:** a device can also join by typing the recovery passphrase. This is meant for the owner's own devices and for recovery.

Only the owner can approve, or an Accountant the owner has allowed to (`canApprove`). Other roles can't add devices or people.

### 3. Offline work

- **Phone offline, or office PC off:** the phone reads from the Firestore offline cache. Its writes are encrypted and queued by Firestore, then sent when it is back online. Other online phones see each other's changes at once, because they don't depend on the PC.
- **Office PC offline:** Tally sync and the PostgreSQL copy pause. When the PC is back online, it gets every record changed since its last `updatedAt` and brings PostgreSQL up to date.
- **Ordering:** each record carries `updatedAt` (server time, set when the write reaches Firebase) and `updatedBy` (device).

### 4. Two devices change the same record while offline (decided: a person chooses)

The owner's decision is that **no version wins automatically**. Both are kept, and a person picks one.

- Every record carries `rev`, a counter that goes up by 1 with each accepted change.
- Every edit is saved as **two separate writes**:
  1. **The edit itself.** It goes to `workspaces/{wid}/{collection}/{id}/edits/{editId}` as `{enc, kv, base, by, at}`. `base` is the `rev` the device last saw. This write is always allowed, and edits are never changed or deleted.
  2. **The record update.** `{enc, kv, rev: base + 1, editId, ...}`. The rules accept it only if `rev` is exactly the stored `rev + 1`.
- **No conflict:** both writes succeed and the edit counts as applied.
- **Conflict:**
  1. Two devices edited from the same `rev` while offline. The first to reach Firebase is applied.
  2. The second record update is refused by the rules, but its edit is still saved.
  3. Any device that finds an edit with `base` lower than the record's `rev`, and no applied mark, shows the record with a **"2 versions — choose one"** warning.
- **Choosing:**
  1. A person sees both versions side by side and picks one, or edits a merged version.
  2. That is saved as a new normal edit (`rev + 1`).
  3. The other edit is marked `resolved` with who chose and when.
  4. The choice is written to History.
- **Nothing is ever lost.** Every edit stays under `edits/`, which fits the no-deletes rule.
- **Most records can't conflict.** New entries (orders, receipts, messages) are created once and don't conflict. Conflicts only happen when two people edit the same existing customer, order or job while offline.
- Settings and Tally data are written by one device (the owner, or the Tally PC), so they never conflict.

### 5. Remote logout

The owner's decision is that **key rotation ships in the first release**, so both parts below are built together.

- **Part 1, block and wipe:**
  1. The owner marks the device `revokedAt`.
  2. The rules refuse any read or write from a revoked device. Every request must carry a `deviceId` whose device document is not revoked.
  3. The existing boot wipe (`cem_wipe`) erases the device's local copy and keys the next time it starts.
- **What part 1 can't do:** a stolen device that never reconnects still has the data already on it, and its copy of the data key. The rules stop it from getting anything new. Part 2 makes that old key useless for new data.
- **Part 2, key rotation (first release):**
  1. After a logout, the owner's device creates data key version `kv + 1`. This happens automatically, as part of the logout.
  2. It wraps the new key for each remaining device in `keys/` and for `recovery`.
  3. All new writes use the new version.
  4. Old records keep their old `kv` and are re-sealed slowly in the background.

  5. A device that was offline during the change gets the new key from `keys/{deviceId}` the next time it connects.
  6. Records sealed with the old key while it was offline still open, because devices keep every key version they were given.
  7. If the owner's device is offline when the logout is pressed, the change runs as soon as it reconnects. Until then, the rules block still applies.

## Firestore rules (outline)

```
function signedIn()          { return request.auth != null; }
function member(wid)         { return exists(/databases/$(database)/documents/workspaces/$(wid)/members/$(request.auth.uid)); }
function owner(wid)          { return get(/databases/$(database)/documents/workspaces/$(wid)).data.ownerUid == request.auth.uid; }

match /workspaces/{wid} {
  allow create: if signedIn() && request.resource.data.ownerUid == request.auth.uid
                && getAfter(/databases/$(database)/documents/workspaces/$(wid)/members/$(request.auth.uid)).data.role == "owner"
                && request.resource.data.status == "trial" && trialUnused();   // one trial per account
                // status, plan, trialEnds and paidUntil can never be written by an app: only the Cloud Function changes them
  allow read:   if member(wid);
  allow update: if owner(wid);                          // name, kv; never ownerUid
  allow delete: if false;

  match /members/{uid}  { allow read: if member(wid); allow write: if owner(wid) || creatingSelfAsOwner(wid); allow delete: if false; }
  match /devices/{id}   { /* member reads; owner approves; revokedAt is one-way, as today */ }
  match /keys/{id}      { allow read: if member(wid) && ownsDevice(wid, id); allow write: if owner(wid); allow delete: if false; }
  match /{coll}/{id}    { allow read, create, update: if member(wid) && sealed(); allow delete: if false; }
}
```

- The current `signedIn()` allowlist of two emails is replaced by `member(wid)`. That list can't work with many customers.
- Each `exists()` and `get()` is a billed read. It is small (about one extra read per request), but counts toward cost.
- The rules are written and tested in the Firebase emulator before the owner publishes them. **The owner publishes the rules, as today.**

## Trial and purchase (decided: automatic)

The owner's decision: anyone can start a **free trial** by themselves, and buying a plan unlocks full access automatically. No one has to approve each customer by hand.

**Flow**
1. A new customer installs the app, signs in with Google and taps **Start free trial**.
2. **Registration:**
   - **Business name and the owner's PAN.**
   - **Consent screen.** In plain words it says:
     - what is stored, and where (their PC, their devices, scrambled in the cloud in Mumbai);
     - that Chittam support can't read the business data;
     - what support can see;
     - how to export the data;
     - how the reset works.

     The owner must tick to agree. The version and time of the consent are saved.
3. The PAN is sent to a Cloud Function, never written by the app directly. It is stored in an operator-only collection, `operator/owners/{uid}`, which no workspace member can read. It is **not** part of the workspace data. The PAN is used only for:
   - one trial per business;
   - the support reset ID check;
   - invoices for the subscription.
4. The workspace is created with `status: "trial"` and `trialEnds = now + trial length`.
5. During the trial (14 days), **all features (Pro)** work, with the office PC and 2 other devices, up to a record cap. On purchase the customer picks a plan; features outside that plan become read-only (as on a downgrade).
6. The app shows the days left and a **Buy** button.
7. **Buy** opens the Cashfree payment page (UPI, card or net banking) for the chosen plan (Basic, Standard or Pro).
8. When the payment succeeds, the gateway calls a **Cloud Function** (webhook). The function checks the gateway's signature, then sets:
   - `status: "active"`;
   - the `plan`;
   - `paidUntil`;
   - a payment record in `workspaces/{wid}/payments/` (never deleted).
9. Renewal works the same way. Reminders are shown 7 days and 1 day before `paidUntil`.
10. **When the trial or the paid period ends**, the workspace becomes **read-only**: the data can be seen and **exported**, but not changed, until payment.

**What makes it safe**
- Only the Cloud Function (Admin SDK) can change `status`, `plan`, `trialEnds` and `paidUntil`. The rules refuse those fields from any app, so a customer can't give themselves a plan.
- The rules check the status on every business write: allowed only when the status is trial and `trialEnds` is still ahead, or active and `paidUntil` is still ahead.
- **One trial per PAN**, plus per Google account and per office PC (machine ID from the Windows app), so the trial can't be restarted endlessly.
- **The PAN is personal data** under the DPDP Act. It is stored once, used only for the purposes listed above, and readable only by Chittam support. It is never shown in full; only the last 4 characters appear on screen.
- Manual payment (a UPI transfer to you) is also supported: you mark it paid in a small operator page, and the same function sets the status.

**What the operator can and can't see:** name, plan, status, dates, device count and storage used. Never the business data, which stays encrypted.

## Abuse and cost

- **Trial limits** keep the Firebase cost of free users small: a few devices, a record cap and a storage cap. These are checked in the rules where possible, and also by the app.
- **Size limit per workspace:** a soft limit on records and storage, checked by the Windows app, with a hard limit in the rules where possible.
- **Budget alert:** set in Google Cloud for the Firebase project, so an unexpected cost shows up within a day.
- **Expected cost:** at the size of Chittam Enterprises, the Blaze free allowance covers most of it. The design keeps reads low with one document per record, the offline cache, and no history replay.

## Moving Chittam Enterprises in (one-time cut-over)

Today all three clients read top-level collections (`customers/`, `orders/`, …). The move:

1. **Prepare.** Release new versions of all three clients (React app, old app with the Android TWA, Windows app). They read and write `workspaces/{wid}/…` only once a `settings/workspace` pointer exists, so until cut-over day they keep using the old paths.
2. **Rules for both paths.** Publish rules that allow the old top-level paths (to the current two emails) and the new workspace paths.
3. **Cut-over day.** The Windows app (owner) does the following:
   1. Creates workspace `chittam`.
   2. Generates the data key and wraps it with the **existing passphrase**. Everyone keeps the same passphrase.
   3. Copies every record by opening it with the old key and sealing it with the new one.
   4. Writes the pointer.
   5. Every client then switches over.
   6. Old documents are left untouched, because there are no deletes.
4. **Check.** Compare counts and totals between the old and new paths, as was done for the PostgreSQL import.
5. **Later.** Once all devices have switched, publish rules that make the old paths read-only.

The devices already signed in keep working. Each one registers its device key on the first start after the update. Existing devices are approved automatically during the cut-over, so they don't need a QR code.

## Work packages (each approved separately)

1. **Relay layer.** Move the existing Firestore calls in all three clients behind `relay`, with no change in behaviour.
2. **Workspace paths and rules.** Add the workspace paths, member rules and emulator tests.
3. **Keys.** Add the data key, the recovery wrap, device key pairs, and `kv` on every sealed record.
4. **Workspace creation and QR pairing.** In the Windows app and the phone app.
5. **Conflicts:** `rev` and `edits`, the "choose one" screen, and History entries.
6. **Remote logout with key rotation.**
7. **Trial and purchase:** workspace status rules, Cloud Function webhook, Buy page, read-only on expiry, operator page.
8. **Roles, the support reset, and registration (PAN and consent).**
9. **Chittam Enterprises cut-over.**
10. **Native Android build** (Capacitor, from branch `postgres-move`), with the same relay and keys.

## Owner decisions

Decided 2026-11-27:
1. **Conflicts:** a person chooses. No automatic winner (see flow 4).
2. **Sign-up:** a free trial that starts automatically, then automatic access after purchase (see "Trial and purchase").
3. **Remote logout:** key rotation is in the first release.
4. **Region:** Mumbai, asia-south1. The region of a Firestore database is fixed when it is created. If the current project's database is in another region, new customers go into a second, named Firestore database in asia-south1 in the same project. Chittam Enterprises can move into it during the cut-over. To check: the current database's region.

5. **Readable data** only on the business's PC and paired devices; the cloud holds scrambled data only.
6. **Five roles:** Owner, Accountant (can approve if allowed), Staff, Outside CA (read only, with an end date), and Chittam support (no data access).
7. **Lost passphrase:** support reset after a PAN check, with a 72-hour wait and alerts. The data is refilled from Tally and the PC's PostgreSQL copy. This replaces the earlier plan line "recovery is owner-held, with no operator bypass". The reset doesn't decrypt anything, so the cloud data stays private.
8. **PAN and a consent screen** at trial start.
9. **PAN check:** a paid PAN verification service at sign-up, run by the Cloud Function (about ₹1–5 per check).
   - The owner opens the provider account; Claude never handles its keys. Cashfree offers PAN verification, so one account can cover both payments and the PAN check.
   - Only the result (valid, and whether the name matches) and the PAN are stored.
   - For a support reset, support also checks a PAN card photo on a video call.
10. **Trial:** 14 days, all features (Pro), 2 devices plus the office PC, with a record cap.
11. **Payment gateway:** Cashfree (UPI, cards, net banking, subscriptions, webhooks). The owner creates the account, completes KYC and keeps the keys in the Cloud Function settings. Manual UPI marked in the operator page remains as a backup.
12. **Plans:** Basic, Standard and Pro, each limited by devices and by features (see "Plans").
13. **After expiry:** read-only, and **export is still allowed**. This replaces "no export on expiry" and avoids the legal question.
14. **Cut-over day for Chittam Enterprises:** once work packages 1–7 are tested in demo, on a quiet day (for example a Sunday), with every device updated first.

Still open:
- **Rupee prices** for each plan, and monthly or yearly billing. The structure is settled; the amounts can be set at any time in the operator page.
- **Feature split between plans:** the table in "Plans" is a proposal for the owner to confirm.

## Plans (proposal)

| | Basic | Standard | Pro |
|---|---|---|---|
| Office PC (Tally sync) | 1 | 1 | 2 |
| Other devices (phones and PCs) | 3 | 8 | 20 |
| Tally companies | 1 | 3 | Unlimited |
| Receivables, payments, reminders, ledgers | Yes | Yes | Yes |
| Orders, products, customers | Yes | Yes | Yes |
| Service jobs, transports | No | Yes | Yes |
| Dashboard widgets | Basic set | All | All |
| Automatic Tally backup | No | Yes | Yes |
| Roles | Owner and Staff | Plus Accountant | Plus Outside CA |
| Post receipts to Tally | No | Yes | Yes |

**How limits are enforced:**
- **Device limit:** only the Cloud Function writes the device count onto the workspace. When the plan's limit is reached, the rules refuse a new `devices/` or `keys/` document.
- **Feature limits:** where a feature has its own collection (service jobs, transports), the rules refuse writes to it on a plan that lacks it. Screen-only features (widgets, some reports) are hidden by the app according to `plan`.
- **What these limits can't stop:** someone who modifies the app themselves could bypass a screen-only limit. That doesn't expose any data and only affects that customer, so it is acceptable.
- **Downgrade:** nothing is deleted. Data from features no longer included becomes read-only. Devices above the new limit stay listed, but the owner must log some out before new ones can be added.
