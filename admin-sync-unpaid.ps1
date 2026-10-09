# =============================================================================
# admin-sync-unpaid.ps1 - retire "past_due" licenses whose Lemon Squeezy
# subscription is already unpaid / expired / ended.
# =============================================================================
# Background: until 2026-10 the webhook did not map LS status "unpaid" (sent
# after the 4 failed retries), so those licenses stayed "past_due" in our DB
# forever. The webhook now maps unpaid -> expired; this script cleans up the
# leftovers ONCE by asking Lemon Squeezy for the real status of every
# past_due license.
#
# Dry run (default) only prints what would change:
#   .\admin-sync-unpaid.ps1
# Apply:
#   .\admin-sync-unpaid.ps1 -Apply
#
# Requires SC_ADMIN_TOKEN and LS_API_KEY env vars (prompts when missing).
# =============================================================================

param(
  [switch]$Apply,
  [string]$Api = "https://api.refinedmotion.de"
)

$ErrorActionPreference = "Stop"

function Read-Secret($name) {
  $secure = Read-Host "Enter $name" -AsSecureString
  return [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$token = $env:SC_ADMIN_TOKEN
if (-not $token) { $token = Read-Secret "SC_ADMIN_TOKEN" }
$lsKey = $env:LS_API_KEY
if (-not $lsKey) { $lsKey = Read-Secret "LS_API_KEY" }

$adminHeaders = @{ Authorization = "Bearer $token" }
$lsHeaders    = @{ Authorization = "Bearer $lsKey"; Accept = "application/vnd.api+json" }

try {
  $list = Invoke-RestMethod -Method Get -Uri "$Api/v1/admin/list-licenses?status=past_due&limit=500" -Headers $adminHeaders
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) { Write-Host "  $($_.ErrorDetails.Message)" -ForegroundColor Red }
  exit 1
}
$rows = @($list.licenses)
Write-Host ""
Write-Host ("past_due licenses in our DB: {0}" -f $rows.Count)
if ($rows.Count -eq 0) { exit 0 }

$toExpire = @()
$keep     = 0
$noSub    = 0
$unknown  = 0
foreach ($lic in $rows) {
  $sub = "$($lic.subscription_id)"
  if (-not ($sub -match '^\d+$')) { $noSub++; Write-Host ("  {0,-34} {1,-28} no LS subscription id -> skipped" -f $lic.key, $lic.email); continue }
  try {
    $ls = Invoke-RestMethod -Method Get -Uri "https://api.lemonsqueezy.com/v1/subscriptions/$sub" -Headers $lsHeaders
  } catch {
    Write-Host ("  {0,-34} {1,-28} LS lookup failed: {2}" -f $lic.key, $lic.email, $_.Exception.Message) -ForegroundColor Yellow
    continue
  }
  $a = $ls.data.attributes
  $lsStatus = "$($a.status)"
  if (-not $lsStatus) {
    $unknown++
    Write-Host ("  {0,-34} {1,-28} unexpected LS response (no status) -> skipped" -f $lic.key, $lic.email) -ForegroundColor Yellow
    continue
  }
  $endsAt   = $a.ends_at
  $ended    = $false
  if ($endsAt) { try { $ended = ([DateTime]::Parse($endsAt).ToUniversalTime() -lt [DateTime]::UtcNow) } catch {} }
  $retire = ($lsStatus -eq "unpaid") -or ($lsStatus -eq "expired") -or (($lsStatus -eq "cancelled") -and $ended)
  if ($retire) {
    $toExpire += [pscustomobject]@{ key = $lic.key; email = $lic.email; ls = $lsStatus; sub = $sub }
    Write-Host ("  {0,-34} {1,-28} LS={2,-9} -> expire" -f $lic.key, $lic.email, $lsStatus) -ForegroundColor Cyan
  } else {
    $keep++
    Write-Host ("  {0,-34} {1,-28} LS={2,-9} keep" -f $lic.key, $lic.email, $lsStatus)
  }
}

Write-Host ""
Write-Host ("to expire: {0}   keep: {1}   without subscription: {2}   unreadable: {3}" -f $toExpire.Count, $keep, $noSub, $unknown)
if (-not $Apply) {
  Write-Host "Dry run - nothing changed. Re-run with -Apply to retire the listed licenses." -ForegroundColor Yellow
  exit 0
}

$done = 0
foreach ($t in $toExpire) {
  $body = @{ licenseKey = $t.key; status = "expired"; reason = "LS subscription $($t.sub) is $($t.ls) (admin-sync-unpaid)" } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$Api/v1/admin/set-license-status" -Headers $adminHeaders -ContentType "application/json" -Body $body
    if ($r.changed) { $done++ }
  } catch {
    Write-Host ("  {0} failed: {1}" -f $t.key, $_.Exception.Message) -ForegroundColor Red
  }
}
Write-Host ("Retired {0} license(s)." -f $done) -ForegroundColor Green
Write-Host ""
