// Reading Tally Prime over its XML port (localhost:9000). Read-only: every
// request here is an Export; nothing is ever written to Tally from this file.
import { XMLParser } from "fast-xml-parser";

export const TALLY_URL = process.env.TALLY_URL || "http://localhost:9000";

// Tally's XML can carry control characters, &#4; markers and UDF: prefixes
function clean(xml: string) {
  return xml
    .replace(/^﻿/, "")
    .replace(/&#(0*[0-8]|0*1[1-2]|0*1[4-9]|0*2[0-9]|0*3[01]);/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/(<\/?)([A-Za-z]\w*):(?=[A-Za-z_])/g, "$1$2_");
}

export async function post(body: string): Promise<string> {
  const res = await fetch(TALLY_URL, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8" }, body });
  if (!res.ok) throw new Error("Tally answered " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  // Tally answers in UTF-16 when asked to, otherwise UTF-8
  const text = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
  const xml = clean(text);
  const err = xml.match(/<LINEERROR>([\s\S]*?)<\/LINEERROR>/);
  if (err) throw new Error("Tally: " + err[1]);
  return xml;
}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true, textNodeName: "#text",
  // lists Tally repeats: always arrays, even with one item
  isArray: (name) => name.endsWith(".LIST") || ["VOUCHER", "LEDGER", "GROUP", "VOUCHERTYPE", "STOCKITEM", "STOCKGROUP", "UNIT", "GODOWN", "COMPANY"].includes(name),
});
export const parse = (xml: string) => parser.parse(xml);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tdate = (iso: string) => iso.replace(/-/g, "");   // 2026-04-01 -> 20260401

// a TDL collection export; returns the parsed objects of `type`
export async function collection(company: string, type: string, fetch: string, opts: { from?: string; to?: string; filter?: string; childOf?: string } = {}) {
  const id = "Chittam" + type;
  const xml = await post(
    "<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>" + id + "</ID></HEADER>" +
    "<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>" + esc(company) + "</SVCURRENTCOMPANY>" +
    (opts.from ? "<SVFROMDATE>" + tdate(opts.from) + "</SVFROMDATE>" : "") + (opts.to ? "<SVTODATE>" + tdate(opts.to) + "</SVTODATE>" : "") +
    "</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME=\"" + id + "\" ISMODIFY=\"No\"><TYPE>" + type + "</TYPE>" +
    (opts.childOf ? "<CHILDOF>" + opts.childOf + "</CHILDOF><BELONGSTO>Yes</BELONGSTO>" : "") +
    "<FETCH>" + fetch + "</FETCH>" + (opts.filter ? "<FILTER>ChittamFilter</FILTER>" : "") + "</COLLECTION>" +
    (opts.filter ? "<SYSTEM TYPE=\"Formulae\" NAME=\"ChittamFilter\">" + esc(opts.filter) + "</SYSTEM>" : "") +
    "</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>");
  const doc = parse(xml);
  const list = doc?.ENVELOPE?.BODY?.DATA?.COLLECTION?.[type.toUpperCase()] || [];
  return list as Record<string, unknown>[];
}

// ---- small readers for Tally's values
export const txt = (v: unknown): string => (v == null ? "" : typeof v === "object" ? txt((v as Record<string, unknown>)["#text"]) : String(v).trim());
export const num = (v: unknown): number => { const m = txt(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : 0; };
export const date = (v: unknown): string | null => { const s = txt(v); return /^\d{8}$/.test(s) ? s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8) : null; };
export const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : v ? [v] : []) as Record<string, unknown>[];
export const lines = (v: unknown, tag: string): string[] => list(v).flatMap((x) => list(x[tag]).map(txt)).filter(Boolean);
export const yes = (v: unknown) => txt(v) === "Yes";
export const nameOf = (o: Record<string, unknown>) => txt(o["@NAME"]) || txt(o.NAME);
