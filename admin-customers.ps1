# =============================================================================
# admin-customers.ps1 - list / search Stacked Captions customers + licenses.
# =============================================================================
# Usage:
#   .\admin-customers.ps1                            # all licenses, summary
#   .\admin-customers.ps1 -Q anna                    # email or key contains "anna"
#   .\admin-customers.ps1 -Status active             # only active subscriptions
#   .\admin-customers.ps1 -Plan monthly              # only monthly plan
#   .\admin-customers.ps1 -Status trial -Plan annual # combine filters
#   .\admin-customers.ps1 -Detail                    # full per-customer view
#   .\admin-customers.ps1 -Limit 25                  # show top 25 only
#
# Requires the ADMIN_TOKEN secret you set with `wrangler secret put`.
# The script reads it from env var SC_ADMIN_TOKEN if set, otherwise prompts.
# To persist across sessions, run once in PowerShell:
#   [Environment]::SetEnvironmentVariable("SC_ADMIN_TOKEN", "your-token", "User")
# Then reopen the shell.
# =============================================================================

param(
  [string]$Api    = "https://api.refinedmotion.de",
  [string]$Q      = "",
  [ValidateSet("", "active", "trial", "cancelled", "past_due", "expired")]
  [string]$Status = "",
  [string]$Plan   = "",
  [int]$Limit     = 100,
  [int]$Offset    = 0,
  [switch]$Detail
)

$ErrorActionPreference = "Stop"

# Get admin token from env or prompt
$token = $env:SC_ADMIN_TOKEN
if (-not $token) {
  $secure = Read-Host "Enter SC_ADMIN_TOKEN" -AsSecureString
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# Build query string
$query = @()
if ($Q)      { $query += "q="      + [Uri]::EscapeDataString($Q) }
if ($Status) { $query += "status=" + [Uri]::EscapeDataString($Status) }
if ($Plan)   { $query += "plan="   + [Uri]::EscapeDataString($Plan) }
$query += "limit=$Limit"
$query += "offset=$Offset"
$url = "$Api/v1/admin/list-licenses?" + ($query -join "&")

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

# ----- Header summary -------------------------------------------------------
Write-Host ""
Write-Host "==============================================================="
Write-Host "  STACKED CAPTIONS -- Customers"
Write-Host "==============================================================="
Write-Host ""
Write-Host "Total licenses: $($response.summary.total_licenses)"
Write-Host ""
Write-Host "By status:" -ForegroundColor Cyan
$response.summary.by_status.PSObject.Properties | ForEach-Object {
  "{0,-12} {1}" -f $_.Name, $_.Value | Write-Host
}
Write-Host ""
Write-Host "By plan:" -ForegroundColor Cyan
$response.summary.by_plan.PSObject.Properties | ForEach-Object {
  "{0,-12} {1}" -f $_.Name, $_.Value | Write-Host
}
Write-Host ""

# Filter state for transparency
$filterDesc = @()
if ($Q)      { $filterDesc += "search='$Q'" }
if ($Status) { $filterDesc += "status=$Status" }
if ($Plan)   { $filterDesc += "plan=$Plan" }
if ($filterDesc.Count -gt 0) {
  Write-Host ("Filters: " + ($filterDesc -join ", ")) -ForegroundColor Yellow
  Write-Host ""
}

# ----- Per-license display --------------------------------------------------
if ($response.licenses.Count -eq 0) {
  Write-Host "No licenses match the filter." -ForegroundColor Yellow
  Write-Host ""
  exit 0
}

Write-Host "Showing $($response.count) of $($response.summary.total_licenses) total"
if ($Offset -gt 0 -or $response.count -lt $response.summary.total_licenses) {
  $tip = "  (offset=" + $Offset + ", limit=" + $Limit + " -- use -Offset/-Limit to page)"
  Write-Host $tip -ForegroundColor DarkGray
}
Write-Host ""

if ($Detail) {
  # Full per-customer view
  $i = 0
  foreach ($lic in $response.licenses) {
    $i++
    $budget = $response.summary.monthly_ai_budget_micro_usd
    $usedPct = if ($budget -gt 0) { [math]::Round(100 * $lic.ai_cost_this_month_micro_usd / $budget, 1) } else { 0 }
    $expiresStr = if ($lic.expires_at) {
      [DateTimeOffset]::FromUnixTimeMilliseconds([long]$lic.expires_at).LocalDateTime.ToString("yyyy-MM-dd")
    } else { "-" }
    $resetStr = if ($lic.ai_cost_reset_at) {
      [DateTimeOffset]::FromUnixTimeMilliseconds([long]$lic.ai_cost_reset_at).LocalDateTime.ToString("yyyy-MM-dd")
    } else { "-" }
    $createdStr = if ($lic.created_at) {
      [DateTimeOffset]::FromUnixTimeMilliseconds([long]$lic.created_at).LocalDateTime.ToString("yyyy-MM-dd")
    } else { "-" }

    Write-Host "--- #$i  $($lic.email)  -----------------------------------" -ForegroundColor Cyan
    Write-Host "  License key   : $($lic.key)"
    Write-Host "  Status        : $($lic.status)"
    Write-Host "  Plan          : $($lic.plan)"
    Write-Host "  Created       : $createdStr"
    Write-Host "  Expires       : $expiresStr"
    Write-Host "  Machines      : $($lic.machines_used) / $($lic.machines_allowed)"
    $aiUsd = "{0:N4}" -f ($lic.ai_cost_this_month_micro_usd / 1000000)
    $budgetUsd = "{0:N2}" -f ($budget / 1000000)
    $pctStr = "$usedPct" + "%"
    Write-Host "  AI cost month : `$$aiUsd of `$$budgetUsd  ($pctStr)"
    Write-Host "  AI calls month: $($lic.ai_calls_this_month)"
    Write-Host "  Quota resets  : $resetStr"
    if ($lic.subscription_id) {
      Write-Host "  LS sub ID     : $($lic.subscription_id)"
    } else {
      Write-Host "  LS sub ID     : - (manually issued, no Lemon Squeezy)"
    }
    Write-Host ""
  }
} else {
  # Compact table view
  $rows = $response.licenses | ForEach-Object {
    $budget = $response.summary.monthly_ai_budget_micro_usd
    $aiUsd = if ($_.ai_cost_this_month_micro_usd) { "{0:N2}" -f ($_.ai_cost_this_month_micro_usd / 1000000) } else { "0.00" }
    $budgetUsd = if ($budget) { "{0:N2}" -f ($budget / 1000000) } else { "?" }
    $expiresStr = if ($_.expires_at) {
      [DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.expires_at).LocalDateTime.ToString("yyyy-MM-dd")
    } else { "-" }
    [PSCustomObject]@{
      Email    = $_.email
      Status   = $_.status
      Plan     = $_.plan
      Key      = $_.key
      Machines = "$($_.machines_used)/$($_.machines_allowed)"
      AI_USD   = "$aiUsd/$budgetUsd"
      Expires  = $expiresStr
    }
  }
  $rows | Format-Table -AutoSize
}

Write-Host ""
Write-Host "Tip: -Detail for full view, -Q '<text>' to search, -Status to filter." -ForegroundColor DarkGray
Write-Host ""
