import { post } from "./tally.ts";
import { loadConfig } from "./config.ts";
import { pool } from "./db.ts";
import * as tally from "./tallyapi.ts";
const p = pool(loadConfig());
const bil = await tally.bills(p) as any;
for (const [co, company] of [["business", "Chittam Enterprises - 2026"], ["cash", "Cash"]]) {
  const xml = await post("<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER><BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>Bills Receivable</REPORTNAME><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>" + company + "</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>");
  const live: { p: string; n: string; a: number; d: string }[] = [];
  const re = /<BILLFIXED>([\s\S]*?)<\/BILLFIXED>\s*<BILLCL>([^<]*)<\/BILLCL>/g;
  for (const m of xml.matchAll(re)) {
    const f = m[1]; const g = (t: string) => (f.match(new RegExp("<" + t + ">([^<]*)</" + t + ">")) || [])[1] || "";
    const a = -Number(m[2]); if (a > 0) live.push({ p: g("BILLPARTY").replace(/&amp;/g, "&"), n: g("BILLREF").replace(/&amp;/g, "&"), a: Math.round(a * 100) / 100, d: g("BILLDATE") });
  }
  const key = (b: any) => b.p.toLowerCase().trim() + "|" + b.n.toLowerCase().trim();
  const mine = new Map<string, number>(bil[co].bills.map((b: any) => [key(b), b.a]));
  let same = 0; const diff: string[] = [];
  for (const b of live) { const m = mine.get(key(b)); if (m === undefined) diff.push("missing in mirror: " + b.p + " | " + b.n + " | " + b.a + " | " + b.d); else if (Math.abs(m - b.a) < 0.01) same++; else diff.push(b.p + " | " + b.n + ": Tally " + b.a + ", mirror " + m); }
  const liveKeys = new Set(live.map(key));
  const extra = bil[co].bills.filter((b: any) => !liveKeys.has(key(b)));
  const tl = live.reduce((t, b) => t + b.a, 0), tm = bil[co].bills.reduce((t: number, b: any) => t + b.a, 0);
  console.log("== " + co + ": Tally now " + live.length + " bills (Rs " + tl.toFixed(2) + ") | mirror " + bil[co].bills.length + " (Rs " + tm.toFixed(2) + ") | same " + same + " | differ " + diff.length + " | only in mirror " + extra.length);
  diff.slice(0, 6).forEach((d) => console.log("   " + d)); extra.slice(0, 6).forEach((b: any) => console.log("   only in mirror: " + b.p + " | " + b.n + " | " + b.a));
}
await p.end();
