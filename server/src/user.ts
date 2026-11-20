// Add a user or set a user's password. Run it yourself in a terminal: the
// password is typed there (hidden) and only its hash is stored.
//   node src/user.ts add you@example.com owner "Your Name"
//   node src/user.ts password you@example.com
//   node src/user.ts list
import { createInterface } from "node:readline";
import { loadConfig } from "./config.ts";
import { pool } from "./db.ts";
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

const [cmd, email, role = "staff", ...nameParts] = process.argv.slice(2);
const db = pool(loadConfig());
try {
  if (cmd === "list") {
    const r = await db.query("SELECT email, role, display_name, active, password_hash IS NOT NULL AS has_password FROM app_users ORDER BY email");
    console.table(r.rows);
  } else if (cmd === "add" && email) {
    if (!["owner", "manager", "staff"].includes(role)) throw new Error("Role must be owner, manager or staff");
    const hash = await hashPassword(await newPassword());
    await db.query(`INSERT INTO app_users (id, email, display_name, role, password_hash) VALUES (lower($1), lower($1), $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, display_name = EXCLUDED.display_name, password_hash = EXCLUDED.password_hash, active = true`,
      [email, nameParts.join(" "), role, hash]);
    await db.query("INSERT INTO activity (by_user, collection, record_id, action, name) VALUES ('setup', 'app_users', lower($1), 'user-added', lower($1))", [email]);
    console.log("Saved " + email.toLowerCase() + " (" + role + ").");
  } else if (cmd === "password" && email) {
    const hash = await hashPassword(await newPassword());
    const r = await db.query("UPDATE app_users SET password_hash = $2 WHERE id = lower($1)", [email, hash]);
    if (!r.rowCount) throw new Error("No such user: " + email);
    await db.query("UPDATE sessions SET ended_at = now() WHERE user_id = lower($1) AND ended_at IS NULL", [email]);   // sign out everywhere
    await db.query("INSERT INTO activity (by_user, collection, record_id, action, name) VALUES ('setup', 'app_users', lower($1), 'password-changed', lower($1))", [email]);
    console.log("Password changed; signed out on all devices.");
  } else if (cmd === "off" && email) {
    // switch a user off (kept, never deleted) and end their sessions
    const r = await db.query("UPDATE app_users SET active = false WHERE id = lower($1)", [email]);
    if (!r.rowCount) throw new Error("No such user: " + email);
    await db.query("UPDATE sessions SET ended_at = now() WHERE user_id = lower($1) AND ended_at IS NULL", [email]);
    await db.query("INSERT INTO activity (by_user, collection, record_id, action, name) VALUES ('setup', 'app_users', lower($1), 'user-switched-off', lower($1))", [email]);
    console.log("Switched off " + email.toLowerCase() + "; signed out everywhere.");
  } else {
    console.log("Usage: node src/user.ts add <email> <owner|manager|staff> [name] | password <email> | off <email> | list");
  }
} catch (e) { console.error((e as Error).message); process.exitCode = 1; }
finally { await db.end(); }
