// The Firebase login and the encryption key the Windows app keeps on this PC
// (%APPDATA%\ChittamEnterprises\settings.json, protected by Windows for this
// Windows user). Read through PowerShell so nothing is stored a second time;
// the server must run as the same Windows user as the Windows app.
import { execFileSync } from "node:child_process";

export interface WinSecrets { email: string; password: string; key: Buffer | null; salt: string; apiKey: string; projectId: string }

const SCRIPT = `
Add-Type -AssemblyName System.Security
$p = Join-Path $env:APPDATA 'ChittamEnterprises\\settings.json'
$s = (Get-Content -Raw -Encoding UTF8 $p) -replace '^\\uFEFF','' | ConvertFrom-Json
function U($b) { if (-not $b) { return '' }; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($b), $null, 'CurrentUser')) }
@{ email = $s.Email; pw = (U $s.PasswordProtected); key = (U $s.EncKeyProtected); salt = $s.EncSalt; apiKey = $s.ApiKey; projectId = $s.ProjectId } | ConvertTo-Json -Compress
`;

export function readWinSecrets(): WinSecrets {
  let out: string;
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  } catch (e) {
    throw new Error("Can't read the Windows app's Tally Sync login on this PC (set it up in Tally Sync first): " + (e as Error).message.split("\n")[0]);
  }
  const j = JSON.parse(out.trim()) as { email?: string; pw?: string; key?: string; salt?: string; apiKey?: string; projectId?: string };
  if (!j.email || !j.pw) throw new Error("The Windows app has no Tally Sync login saved on this PC.");
  return {
    email: j.email, password: Buffer.from(j.pw, "base64").toString("utf8"),
    key: j.key ? Buffer.from(j.key, "base64") : null, salt: j.salt || "",
    apiKey: j.apiKey || "", projectId: j.projectId || "chittam-enterprises",
  };
}
