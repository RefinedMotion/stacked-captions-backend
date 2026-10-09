# =============================================================================
# admin-remove-machine.ps1 - free a machine slot of a customer's license.
# =============================================================================
# Support case "machine limit reached": the customer's license has a stale
# machine (reinstalled Windows, replaced laptop). Since v1.1.0 customers can
# do this themselves (License & Account > Manage machines); this script is
# for the cases that still reach support.
#
# Find the machine first:
#   .\admin-customer-detail.ps1 -Q anna@example.com      # prints id=.. [display id] (sc-m-...) per machine
#
# Then (the display id is what the customer sees in the panel):
#   .\admin-remove-machine.ps1 -Key SC-4Y6A-... -DisplayId 3f9a1c77
#   .\admin-remove-machine.ps1 -Key SC-4Y6A-... -MachineId 123
#   .\admin-remove-machine.ps1 -Key SC-4Y6A-... -Fingerprint sc-m-6ab1c2d3   # unique prefix is enough
#
# Requires SC_ADMIN_TOKEN env var or it will prompt.
# =============================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$Key,

  [string]$Fingerprint = "",
  [string]$DisplayId   = "",
  [int]$MachineId      = 0,

  [string]$Api         = "https://api.refinedmotion.de"
)

$ErrorActionPreference = "Stop"

$Fingerprint = $Fingerprint.Trim().TrimEnd('.')
$DisplayId   = $DisplayId.Trim().TrimEnd('.')
if (-not $Fingerprint -and -not $DisplayId -and $MachineId -le 0) {
  Write-Host "Give -DisplayId (as shown in the panel / customer-detail), -MachineId or -Fingerprint (unique prefix)." -ForegroundColor Red
  exit 1
}

$token = $env:SC_ADMIN_TOKEN
if (-not $token) {
  $secure = Read-Host "Enter SC_ADMIN_TOKEN" -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

function Format-Date($ms) {
  if (-not $ms -or $ms -eq 0) { return "-" }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime.ToString("yyyy-MM-dd")
}
function Show-Machines($machines) {
  if (-not $machines -or $machines.Count -eq 0) { Write-Host "    (no machines registered)"; return }
  foreach ($m in $machines) {
    $os  = if ($m.os) { $m.os } else { "?" }
    $ver = if ($m.appVersion) { $m.appVersion } else { "?" }
    Write-Host ("    id={0,-6} [{1}]  {2}  v{3}  first={4}  last={5}" -f $m.id, $m.displayId, $os, $ver, (Format-Date $m.firstSeenAt), (Format-Date $m.lastSeenAt))
  }
}

$body = @{ licenseKey = $Key }
if ($MachineId -gt 0) { $body.machineId = $MachineId }
elseif ($DisplayId) { $body.displayId = $DisplayId }
else { $body.fingerprint = $Fingerprint }
$json = $body | ConvertTo-Json -Compress

try {
  $response = Invoke-RestMethod -Method Post -Uri "$Api/v1/admin/remove-machine" -Headers @{
    Authorization = "Bearer $token"
  } -ContentType "application/json" -Body $json
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) {
    Write-Host "  $($_.ErrorDetails.Message)" -ForegroundColor Red
    try {
      $err = $_.ErrorDetails.Message | ConvertFrom-Json
      if ($err.machines) { Write-Host ""; Write-Host "  Machines on this license:" -ForegroundColor Yellow; Show-Machines $err.machines }
    } catch {}
  }
  exit 1
}

Write-Host ""
Write-Host ("Removed machine [{0}] ({1}, v{2}, last seen {3}) from {4}" -f $response.removed.displayId, $response.removed.os, $response.removed.appVersion, (Format-Date $response.removed.lastSeenAt), $Key) -ForegroundColor Green
Write-Host ("Slots now: {0} / {1}" -f $response.machinesUsed, $response.machinesAllowed)
Write-Host ""
Write-Host "  Remaining machines:" -ForegroundColor Yellow
Show-Machines $response.machines
Write-Host ""
