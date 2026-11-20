// Where the server finds its settings: D:\ChittamSuite\config\server.json by
// default (CHITTAM_CONFIG overrides). The file is written by setup-db.ps1 and
// holds the database login for the app's own role, never the admin password.
import { readFileSync } from "node:fs";

export interface Config {
  db: { host: string; port: number; database: string; user: string; password: string };
  http: { host: string; port: number };
  storage: string;   // folder for photos / PDFs / documents
}

export const CONFIG_PATH = process.env.CHITTAM_CONFIG || "D:\\ChittamSuite\\config\\server.json";

export function loadConfig(): Config {
  let raw: Partial<Config>;
  try { raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); }
  catch (e) { throw new Error("Can't read " + CONFIG_PATH + " (run server\\setup-db.ps1 first): " + (e as Error).message); }
  if (!raw.db?.password) throw new Error(CONFIG_PATH + " has no database login.");
  return {
    db: { host: raw.db.host || "localhost", port: raw.db.port || 5432, database: raw.db.database || "chittam", user: raw.db.user || "chittam_app", password: raw.db.password },
    // only this PC for now; the mesh VPN address is added when phones connect
    http: { host: raw.http?.host || "127.0.0.1", port: raw.http?.port || 8484 },
    storage: raw.storage || "D:\\ChittamSuite\\storage",
  };
}
