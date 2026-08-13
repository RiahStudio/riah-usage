# Restart the Riah Usage tray -- stop the old one, PROVE it stopped, start a
# new one, PROVE it came up.
#
# This lives in its own file on purpose. It used to be a multi-line PowerShell
# command embedded in a .bat with "^" continuations; cmd joined those lines
# without separators and PowerShell received a mangled script. Never put
# multi-line PowerShell inside a .bat -- put it here, where it can be tested.
#
# Keep this file ASCII-only (Windows PowerShell 5.1).

$ErrorActionPreference = 'SilentlyContinue'

function Get-TrayProcs {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match 'powershell|pwsh' -and
    $_.CommandLine -and
    $_.CommandLine -match 'riah-usage-tray' -and
    $_.CommandLine -notmatch 'RenderTo'   # proof renders are not the tray
  })
}

Write-Host 'Stopping the old tray...'
$procs = Get-TrayProcs
if ($procs.Count -eq 0) {
  Write-Host '  nothing was running.'
} else {
  Write-Host ('  found ' + $procs.Count + ' - stopping.')
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force } catch {}
  }
  $gone = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    if ((Get-TrayProcs).Count -eq 0) { $gone = $true; break }
  }
  if (-not $gone) {
    Write-Host ''
    Write-Host '  STILL RUNNING after 8 seconds.'
    Write-Host '  Nothing was started, so you are not running two of them.'
    Write-Host '  Tell Claude: the restart could not stop the old tray.'
    Write-Host ''
    exit 1
  }
  Write-Host '  stopped.'
}

Write-Host 'Starting the new one...'
$vbs = Join-Path $PSScriptRoot 'tray-hidden.vbs'
if (-not (Test-Path $vbs)) {
  Write-Host ('  MISSING: ' + $vbs)
  exit 1
}
Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', '//Nologo', ('"{0}"' -f $vbs) -WindowStyle Hidden

# Prove it came up via the tray's named mutex, not a WMI process scan. The
# CIM query was slow/flaky here and PowerShell itself can take 10-25s to boot
# on this machine, so the old 6s process probe kept reporting "did NOT come
# up" for a tray that was fine seconds later (2026-08-11, twice). The mutex
# is grabbed in the tray's first moments, so it is both early and definitive.
for ($i = 0; $i -lt 75; $i++) {
  Start-Sleep -Milliseconds 400
  $m = $null
  if ([System.Threading.Mutex]::TryOpenExisting('RiahUsageTray', [ref]$m)) {
    try { $m.Dispose() } catch {}
    Write-Host '  running.'
    Write-Host ''
    Write-Host 'Done. Left-click the icon by the clock.'
    exit 0
  }
}

Write-Host ''
Write-Host '  It did NOT come up after 30 seconds. Tell Claude - the log is scratch\tray.log'
Write-Host ''
exit 1
