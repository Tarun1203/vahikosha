// one small request: is Tally answering, and which companies are open?
import { post } from "./tally.ts";
const t0 = Date.now();
const xml = await post("<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>", 15000);
console.log("Tally answered in " + (Date.now() - t0) + " ms; open companies: " + [...xml.matchAll(/<COMPANY NAME="([^"]+)"/g)].map((m) => m[1]).join(", "));
