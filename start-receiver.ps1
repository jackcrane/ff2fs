param(
  [switch]$Elevated,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$ruleSpecs = @(
  @{ Name = 'FF2FS OANP TCP 8384'; Protocol = 'TCP'; Port = 8384 },
  @{ Name = 'FF2FS OANP UDP 8384'; Protocol = 'UDP'; Port = 8384 },
  @{ Name = 'FF2FS OANP TCP 4000'; Protocol = 'TCP'; Port = 4000 },
  @{ Name = 'FF2FS ForeFlight transfer TCP 64099'; Protocol = 'TCP'; Port = 64099 }
)

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdministrator) {
  if (-not $NodePath) {
    $NodePath = (Get-Command node -ErrorAction Stop).Source
  }
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-NodePath', "`"$NodePath`"")
  Start-Process -FilePath powershell.exe -Verb RunAs -ArgumentList $arguments
  exit 0
}

foreach ($spec in $ruleSpecs) {
  if (-not (Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
      -DisplayName $spec.Name `
      -Description 'FF2FS ForeFlight-compatible OANP panel receiver; permits local Wi-Fi subnet only.' `
      -Direction Inbound `
      -Action Allow `
      -Protocol $spec.Protocol `
      -LocalPort $spec.Port `
      -RemoteAddress LocalSubnet `
      -Profile Public | Out-Null
  }
}

# A previous visible receiver may have been closed without its Node child
# exiting.  Remove only Node listeners on this app's two ports; unrelated
# applications and all other ports are left untouched.
$stalePids = @(Get-NetTCPConnection -LocalPort 8384,4000,64099 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($ownerPid in $stalePids) {
  $process = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($process -and $process.ProcessName -eq 'node') {
    Write-Host "Stopping stale FF2FS listener (PID $ownerPid)."
    Stop-Process -Id $ownerPid -Force
  }
}

Write-Host 'FF2FS firewall rules are active: local subnet only, TCP/UDP 8384, TCP 4000, and TCP 64099.'
Set-Location $PSScriptRoot
if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction Stop).Source
}
$env:FF2FS_EFB_BRIDGE = '1'
$env:FF2FS_MSFS_LOAD = '0'
Write-Host 'MSFS EFB route bridge enabled on localhost:64098.'
Write-Host 'Legacy SimConnect FlightPlanLoad disabled; the MSFS 2024 EFB route bridge is authoritative.'
& $NodePath .\src\oanp-probe.js
