# =============================================================================
# test-update-endpoint.ps1 — End-to-end smoke test for /v1/check-update.
# =============================================================================
# What it does:
#   1. POST /v1/activate    with your license key + a stable test fingerprint
#                           → gets back a signed token
#   2. POST /v1/check-update with the token, currentVersion=1.0.0, platform=win
#                           → prints what the Worker thinks is the latest
#                              release on GitHub
#
# Run from PowerShell:
#   cd "C:\Users\Philipp Kies\stacked-captions-backend"
#   .\test-update-endpoint.ps1 -LicenseKey "SC-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
#
# Note on machine slots:
#   This script uses a stable fingerprint ("smoke-test-cli") so re-running
#   it doesn't burn a new slot — it just refreshes the same record. The
#   first run does consume 1 of your 2 machine slots, though. Free it up
#   later via /v1/admin/find-license + manual DB delete if needed.
# =============================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$LicenseKey,

  [string]$Api = "https://api.refinedmotion.de",
  [string]$CurrentVersion = "1.0.0",
  [ValidateSet("win", "mac")]
  [string]$Platform = "win"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────────"
Write-Host "  Smoke test: $Api"
Write-Host "──────────────────────────────────────────────────────────────────"

# -----------------------------------------------------------------------------
# Step 1: Activate (or re-activate) to get a fresh token
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[1/2] POST /v1/activate ..."

$activateBody = @{
  licenseKey  = $LicenseKey
  fingerprint = "smoke-test-cli"
  os          = "windows"
  appVersion  = $CurrentVersion
} | ConvertTo-Json

try {
  $act = Invoke-RestMethod -Method Post `
    -Uri "$Api/v1/activate" `
    -ContentType "application/json" `
    -Body $activateBody
} catch {
  Write-Host "  ❌ Activate failed:" -ForegroundColor Red
  Write-Host "     $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) {
    Write-Host "     $($_.ErrorDetails.Message)" -ForegroundColor Red
  }
  exit 1
}

Write-Host "  ✅ Activated"
Write-Host "     Plan:            $($act.plan)"
Write-Host "     Machines used:   $($act.machinesUsed) / $($act.machinesAllowed)"
Write-Host "     Token (first 20): $($act.token.Substring(0, 20))..."

# -----------------------------------------------------------------------------
# Step 2: Check for update
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "[2/2] POST /v1/check-update (currentVersion=$CurrentVersion, platform=$Platform) ..."

$checkBody = @{
  token          = $act.token
  currentVersion = $CurrentVersion
  platform       = $Platform
} | ConvertTo-Json

try {
  $upd = Invoke-RestMethod -Method Post `
    -Uri "$Api/v1/check-update" `
    -ContentType "application/json" `
    -Body $checkBody
} catch {
  Write-Host "  ❌ check-update failed:" -ForegroundColor Red
  Write-Host "     $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) {
    Write-Host "     $($_.ErrorDetails.Message)" -ForegroundColor Red
  }
  exit 1
}

Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────────"
Write-Host "  RESULT"
Write-Host "──────────────────────────────────────────────────────────────────"
if ($upd.updateAvailable) {
  Write-Host "  ✅ Update available: $($upd.latestVersion) (was $CurrentVersion)" -ForegroundColor Green
} else {
  Write-Host "  ✓  No update — already on latest ($($upd.latestVersion))" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "  Release:       $($upd.releaseName)"
Write-Host "  Required:      $($upd.isRequired)"
Write-Host "  Published at:  $($upd.publishedAt)"
if ($upd.download) {
  Write-Host "  Download:"
  Write-Host "    File:   $($upd.download.fileName)"
  Write-Host "    Size:   $($upd.download.sizeBytes) bytes"
  Write-Host "    URL:    $($upd.download.url.Substring(0, [Math]::Min(80, $upd.download.url.Length)))..."
} else {
  Write-Host "  ⚠  No download asset for platform '$Platform'" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Full response (JSON):"
$upd | ConvertTo-Json -Depth 4
Write-Host ""
