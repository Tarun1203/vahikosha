# One-time setup of the Chittam database on this PC.
#  - creates D:\ChittamSuite\{config,storage,backups,logs}
#  - makes a database user "chittam_app" with a random password, saved only in
#    D:\ChittamSuite\config\server.json (readable by this Windows account only)
#  - creates the database "chittam" and applies the tables (npm run migrate)
# psql asks for the PostgreSQL admin ("postgres") password: type it yourself.
param(
  [string]$Root = "D:\ChittamSuite",
  [string]$PgBin = "D:\ChittamSuite\PostgreSQL\17\bin",
  [int]$Port = 5432
)
$ErrorActionPreference = "Stop"
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "psql.exe not found in $PgBin - is PostgreSQL installed there?" }

foreach ($d in "config", "logs", "backups\daily", "backups\weekly", "storage\products", "storage\customers", "storage\invoices", "storage\service-photos", "storage\attachments") {
  New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null
}

$cfgPath = Join-Path $Root "config\server.json"
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  $appPw = $cfg.db.password
  Write-Host "Using the existing login in $cfgPath"
} else {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $appPw = [Convert]::ToBase64String($bytes).Replace("+", "A").Replace("/", "B").Replace("=", "")
  $cfg = [ordered]@{
    db = [ordered]@{ host = "localhost"; port = $Port; database = "chittam"; user = "chittam_app"; password = $appPw }
    http = [ordered]@{ host = "127.0.0.1"; port = 8484 }
    storage = (Join-Path $Root "storage")
  }
  $cfg | ConvertTo-Json -Depth 4 | Set-Content -Path $cfgPath -Encoding utf8
  # only this Windows account (and the system) can read the file
  icacls $cfgPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "SYSTEM:(F)" | Out-Null
  Write-Host "Saved the app's database login in $cfgPath"
}

# the SQL reads the password from a psql variable, so it never appears on screen or in history
$sql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chittam_app') THEN
    CREATE ROLE chittam_app LOGIN;
  END IF;
END `$`$;
ALTER ROLE chittam_app WITH LOGIN PASSWORD :'apppw';
SELECT 'CREATE DATABASE chittam OWNER chittam_app ENCODING ''UTF8'' TEMPLATE template0'
  WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'chittam') \gexec
"@
$tmp = Join-Path $env:TEMP ("chittam-setup-" + [guid]::NewGuid() + ".sql")
Set-Content -Path $tmp -Value $sql -Encoding ascii
Write-Host ""
Write-Host "PostgreSQL will now ask for the admin (postgres) password you chose during install."
try {
  & $psql -h localhost -p $Port -U postgres -d postgres -v ON_ERROR_STOP=1 -v "apppw=$appPw" -f $tmp
  if ($LASTEXITCODE -ne 0) { throw "psql failed (exit $LASTEXITCODE)" }
} finally { Remove-Item $tmp -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "Creating the tables..."
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path "node_modules")) { npm install --no-audit --no-fund | Out-Null }
  node src/migrate.ts
  if ($LASTEXITCODE -ne 0) { throw "migrations failed" }
  node src/check.ts
} finally { Pop-Location }
Write-Host ""
Write-Host "Done. The Chittam database is ready."
