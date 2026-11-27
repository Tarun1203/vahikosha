// Add a user or set a user's password. Run it yourself in a terminal: the
// password is typed there (hidden) and only its hash is stored.
//   node src/user.ts add you@example.com owner "Your Name"   (roles: owner, accountant, staff, outside_ca)
//   node src/user.ts password you@example.com
//   node src/user.ts list
//   node src/user.ts businesses | new-business "Name" | support you@chittam.in
// Add --business <id> to work on a business other than Chittam Enterprises.
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { CHITTAM_BUSINESS, inBusiness, pool } from "./db.ts";
import { hashPassword } from "./auth.ts";

// reads the keyboard directly and shows * for each character typed
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {   // not a console (e.g. piped): read one line as is
      const rl = createInterface({ input: stdin });
      rl.once("line", (l) => { rl.close(); resolve(l); });
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData);
          process.stdout.write("\n"); resolve(value); return;
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }        // Ctrl-C
        if (ch === "\u007f" || ch === "\b") { if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        if (ch >= " ") { value += ch; process.stdout.write("*"); }
      }
    };
    stdin.on("data", onData);
  });
}

async function newPassword() {
  // for a generated test login: the password comes from the environment, not the keyboard
  const given = process.env.CHITTAM_NEW_PASSWORD;
  if (given) { if (given.length < 8) throw new Error("Password too short"); return given; }
  for (;;) {
    const a = await askHidden("New password (at least 8 characters): ");
    if (a.length < 8) { console.log("Too short."); continue; }
    const b = await askHidden("Type it again: ");
    if (a !== b) { console.log("They don't match, try again."); continue; }
    return a;
  }
}

const ROLES = ["owner", "accountant", "staff", "outside_ca"];
const role = (r: string) => (r === "manager" ? "accountant" : r);   // old name
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --business <id> picks the business (default: Chittam Enterprises)
const args = process.argv.slice(2);
const bi = args.indexOf("--business");
const business = bi >= 0 ? args.splice(bi, 2)[1] : CHITTAM_BUSINESS;
const [cmd, email, roleArg = "staff", ...nameParts] = args;
const db = pool(loadConfig(), null, "vahikosha-user-tool");
const log = (action: string, id: string) =>
  inBusiness(db, business, (c) => c.query("INSERT INTO activity (by_user, collection, record_id, action, name) VALUES ('setup', 'app_users', $1, $2, $1)", [id, action]));

try {
  if (!UUID.test(business)) throw new Error("--business needs a business id (see: node src/user.ts businesses)");
  if (cmd === "list") {
    const r = await db.query(`SELECT u.email, m.role, u.display_name, u.active AND m.active AS active, u.password_hash IS NOT NULL AS has_password
      FROM members m JOIN app_users u ON u.id = m.user_id WHERE m.business_id = $1 ORDER BY u.email`, [business]);
    console.table(r.rows);
  } else if (cmd === "businesses") {
    const r = await db.query("SELECT b.id, b.name, b.status, (SELECT count(*)::int FROM members m WHERE m.business_id = b.id AND m.active) AS members FROM businesses b ORDER BY b.name");
    console.table(r.rows);
  } else if (cmd === "new-business" && email) {
    // here the second word is the business name: node src/user.ts new-business "Sri Ganesh Traders"
    const name = [email, roleArg === "staff" ? "" : roleArg, ...nameParts].join(" ").trim();
    const r = await db.query("INSERT INTO businesses (name) VALUES ($1) RETURNING id", [name]);
    await inBusiness(db, r.rows[0].id, (c) => c.query("INSERT INTO activity (by_user, collection, action, name) VALUES ('setup', 'business', 'business-created', $1)", [name]));
    console.log("Made " + name + ": " + r.rows[0].id + "\nAdd its owner: node src/user.ts add <email> owner \"Name\" --business " + r.rows[0].id);
  } else if (cmd === "add" && email) {
    const rl = role(roleArg);
    if (!ROLES.includes(rl)) throw new Error("Role must be owner, accountant, staff or outside_ca");
    const exists = (await db.query("SELECT 1 FROM app_users WHERE id = lower($1)", [email])).rowCount;
    // a person already signed up keeps their password; a new one sets it now
    const hash = exists && !process.env.CHITTAM_NEW_PASSWORD ? null : await hashPassword(await newPassword());
    await db.query(`INSERT INTO app_users (id, email, display_name, role, password_hash) VALUES (lower($1), lower($1), $2, 'staff', $3)
      ON CONFLICT (id) DO UPDATE SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), app_users.display_name),
        password_hash = COALESCE(EXCLUDED.password_hash, app_users.password_hash), active = true`,
      [email, nameParts.join(" "), hash]);
    await db.query(`INSERT INTO members (business_id, user_id, role, added_by) VALUES ($1, lower($2), $3, 'setup')
      ON CONFLICT (business_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true`, [business, email, rl]);
    await log("member-added", email.toLowerCase());
    console.log("Saved " + email.toLowerCase() + " (" + rl + ").");
  } else if (cmd === "support" && email) {
    // Chittam support staff: can sign in, can't open any business
    const hash = await hashPassword(await newPassword());
    await db.query(`INSERT INTO app_users (id, email, display_name, role, password_hash, is_support) VALUES (lower($1), lower($1), $2, 'staff', $3, true)
      ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_support = true, active = true`, [email, roleArg === "staff" ? "" : [roleArg, ...nameParts].join(" "), hash]);
    console.log("Saved " + email.toLowerCase() + " as Chittam support (no access to business data).");
  } else if (cmd === "password" && email) {
    const hash = await hashPassword(await newPassword());
    const r = await db.query("UPDATE app_users SET password_hash = $2 WHERE id = lower($1)", [email, hash]);
    if (!r.rowCount) throw new Error("No such user: " + email);
    await db.query("UPDATE sessions SET ended_at = now() WHERE user_id = lower($1) AND ended_at IS NULL", [email]);   // sign out everywhere
    console.log("Password changed; signed out on all devices.");
  } else if (cmd === "off" && email) {
    // take someone out of this business (kept, never deleted) and end their sessions there
    const r = await db.query("UPDATE members SET active = false WHERE business_id = $1 AND user_id = lower($2)", [business, email]);
    if (!r.rowCount) throw new Error("No such member: " + email);
    await db.query("UPDATE sessions SET ended_at = now() WHERE user_id = lower($1) AND business_id = $2 AND ended_at IS NULL", [email, business]);
    await log("member-switched-off", email.toLowerCase());
    console.log("Switched off " + email.toLowerCase() + " in this business; signed out there.");
  } else {
    console.log(`Usage (add --business <id> for a business other than Chittam Enterprises):
  node src/user.ts add <email> <owner|accountant|staff|outside_ca> [name]
  node src/user.ts off <email> | password <email> | list
  node src/user.ts businesses | new-business <name> | support <email> [name]`);
  }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { await db.end(); }
