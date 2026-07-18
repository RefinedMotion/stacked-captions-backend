# =============================================================================
# admin-customer-detail.ps1 - deep-dive into ONE customer's history.
# =============================================================================
# Shows: license info, machine list, event timeline (newest first), monthly
# AI-spend rollup, Lemon Squeezy link for billing-side history.
#
# Usage:
#   .\admin-customer-detail.ps1 -Q anna@example.com    # by email
#   .\admin-customer-detail.ps1 -Q SC-4Y6A             # by partial license key
#   .\admin-customer-detail.ps1 -Q anna -EventsLimit 50
#
# Requires SC_ADMIN_TOKEN env var (set via [Environment]::SetEnvironmentVariable)
# or it will prompt.
# =============================================================================

param(
  [Parameter(Mandatory = $true)]
  [string]$Q,

  [string]$Api         = "https://api.refinedmotion.de",
  [int]$EventsLimit    = 200
)

$ErrorActionPreference = "Stop"

# Get admin token from env or prompt
$token = $env:SC_ADMIN_TOKEN
if (-not $token) {
  $secure = Read-Host "Enter SC_ADMIN_TOKEN" -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$url = "$Api/v1/admin/customer-detail?q=" + [Uri]::EscapeDataString($Q) + "&events_limit=$EventsLimit"

try {
  $response = Invoke-RestMethod -Method Get -Uri $url -Headers @{
    Authorization = "Bearer $token"
  }
} catch {
  Write-Host "Request failed: $($_.Exception.Message)" -ForegroundColor Red
  if ($_.ErrorDetails.Message) {
    Write-Host "  $($_.ErrorDetails.Message)" -ForegroundColor Red
  }
  exit 1
}

# Helper: convert ms-epoch to readable local date+time
function Format-Timestamp($ms) {
  if (-not $ms -or $ms -eq 0) { return "-" }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime.ToString("yyyy-MM-dd HH:mm")
}
function Format-Date($ms) {
  if (-not $ms -or $ms -eq 0) { return "-" }
  return [DateTimeOffset]::FromUnixTimeMilliseconds([long]$ms).LocalDateTime.ToString("yyyy-MM-dd")
}
function Format-USD($microUsd) {
  return "`$" + ("{0:N4}" -f ($microUsd / 1000000))
}

Write-Host ""
if ($response.matches -eq 0) {
  Write-Host "No customer matches '$Q'." -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

$plural = ""
if ($response.matches -ne 1) { $plural = "es" }

Write-Host "==============================================================="
Write-Host "  CUSTOMER DETAIL  ('$Q' -> $($response.matches) match$plural)"
Write-Host "==============================================================="

$i = 0
foreach ($cust in $response.customers) {
  $i++

  Write-Host ""
  Write-Host "--- Customer #$i / $($response.matches) ----------------------------" -ForegroundColor Cyan
  Write-Host "  Email           : $($cust.email)"
  Write-Host "  License key     : $($cust.key)"
  Write-Host "  Status          : $($cust.status)"
  Write-Host "  Plan            : $($cust.plan)"
  $userSince = Format-Date $cust.user_created_at
  $licSince  = Format-Date $cust.created_at
  Write-Host "  Customer since  : $userSince (license: $licSince)"
  $expStr = Format-Date $cust.expires_at
  Write-Host "  Expires         : $expStr"
  $upStr = Format-Timestamp $cust.updated_at
  Write-Host "  Last updated    : $upStr"
  Write-Host "  Machines allowed: $($cust.machines_allowed)"
  $aiNow    = Format-USD $cust.ai_cost_this_month_micro_usd
  $aiLimit  = Format-USD $cust.ai_cost_limit_micro_usd
  Write-Host "  AI cost (now)   : $aiNow of $aiLimit  ($($cust.ai_calls_this_month) calls)"
  $resetStr = Format-Date $cust.ai_cost_reset_at
  Write-Host "  Quota resets    : $resetStr"
  if ($cust.subscription_id) {
    Write-Host "  Lemon Squeezy   : $($cust.subscription_id)"
    Write-Host "                    -> $($cust.lemon_squeezy_url)"
  } else {
    Write-Host "  Lemon Squeezy   : - (manually issued, no LS subscription)"
  }

  # ----- Machines ---------------------------------------------------------
  Write-Host ""
  Write-Host "  MACHINES ($($cust.machines.Count) registered)" -ForegroundColor Yellow
  if ($cust.machines.Count -eq 0) {
    Write-Host "    (none - license never activated)"
  } else {
    foreach ($m in $cust.machines) {
      $fp = "?"
      if ($m.fingerprint) {
        $len = [Math]::Min(12, $m.fingerprint.Length)
        $fp = $m.fingerprint.Substring(0, $len) + "..."
      }
      $os  = if ($m.os) { $m.os } else { "?" }
      $ver = if ($m.app_version) { $m.app_version } else { "?" }
      $firstStr = Format-Date $m.first_seen_at
      $lastStr  = Format-Date $m.last_seen_at
      Write-Host ("    [{0}]  {1}  v{2}  first={3}  last={4}" -f $fp, $os, $ver, $firstStr, $lastStr)
    }
  }

  # ----- Monthly AI rollup ------------------------------------------------
  Write-Host ""
  Write-Host "  MONTHLY AI SPEND (from events table, only includes calls after migration)" -ForegroundColor Yellow
  if ($cust.monthly_ai_spend.Count -eq 0) {
    Write-Host "    (no AI calls recorded yet)"
  } else {
    Write-Host "    Month     Calls   Cost"
    Write-Host "    -----     -----   ----"
    foreach ($m in $cust.monthly_ai_spend) {
      $costStr = Format-USD $m.total_micro_usd
      Write-Host ("    {0,-7} {1,7}   {2,10}" -f $m.month, $m.calls, $costStr)
    }
  }

  # ----- Event timeline ---------------------------------------------------
  Write-Host ""
  Write-Host "  EVENT TIMELINE ($($cust.events.Count) shown, newest first)" -ForegroundColor Yellow
  if ($cust.events.Count -eq 0) {
    Write-Host "    (no events captured - table may have been added after this customer started)"
  } else {
    foreach ($e in $cust.events) {
      $ts = Format-Timestamp $e.created_at
      $type = $e.event_type
      $costStr = ""
      if ($e.cost_micro_usd -gt 0) {
        $costStr = " " + (Format-USD $e.cost_micro_usd)
      }
      $detailStr = ""
      if ($e.detail) {
        $pairs = @()
        $e.detail.PSObject.Properties | ForEach-Object {
          $val = $_.Value
          if ($val -is [long] -and $val -gt 1000000000000) {
            $val = Format-Date $val
          }
          $pairs += ($_.Name + "=" + $val)
        }
        if ($pairs.Count -gt 0) {
          $detailStr = "  (" + ($pairs -join ", ") + ")"
        }
      }
      Write-Host ("    {0}  {1}{2}{3}" -f $ts, $type, $costStr, $detailStr)
    }
  }
  Write-Host ""
}

Write-Host "==============================================================="
Write-Host ""
