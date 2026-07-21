# Start Riah Usage -- the desk (your meters) and the tray icon by the clock.
#
# Safe to run any time: it skips whatever is already going.
#
# This lives in PowerShell, not in the .bat, ON PURPOSE. The .bat version used a
# `for /f` loop and parenthesised blocks to hunt for Node, and Windows batch
# mangled it -- cmd began executing fragments of the file's own text ("etlocal",
# "/d", "M", "not"). Same lesson as the restart script: one file, one language.
#
# Keep this file ASCII-only (Windows PowerShell 5.1).

$ErrorActionPreference = 'SilentlyContinue'
$ROOT = Split-Path -Parent $PSScriptRoot   # ...\Riah Usage

function Say([string]$m) { Write-Host $m }
function Ok([string]$m) { Write-Host ('  OK   ' + $m) -ForegroundColor Green }
function Bad([string]$m) { Write-Host ('  ' + $m) -ForegroundColor Red }

Say ''
Say '=================================================='
Say '  Starting Riah Usage'
Say '=================================================='
Say ''

# --- find Node ---------------------------------------------------------------
# The old hidden launcher checked exactly three folders. Node installed via
# fnm, nvm, Volta or Scoop lives elsewhere, so it failed in an invisible window
# and "Start desk" appeared to do nothing at all.
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }

if (-not $node) {
  $guesses = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\node\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
    'C:\nvm4w\nodejs\node.exe',
    (Join-Path $env:APPDATA 'npm\node.exe'),
    (Join-Path $env:USERPROFILE 'scoop\shims\node.exe')
  )
  foreach ($g in $guesses) {
    if ($g -and (Test-Path $g)) { $node = $g; break }
  }
}

if (-not $node) {
  # fnm and nvm keep one folder per installed version.
  $roots = @(
    (Join-Path $env:APPDATA 'fnm\node-versions'),
    (Join-Path $env:LOCALAPPDATA 'fnm_multishells'),
    (Join-Path $env:APPDATA 'nvm')
  )
  foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $found = Get-ChildItem -Path $r -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $node = $found.FullName; break }
  }
}

if (-not $node) {
  Say ''
  Bad 'Could not find Node.js on this computer.'
  Say '  It is free: https://nodejs.org  -- install it, then run this again.'
  Say ''
  Start-Process 'https://nodejs.org/'
  Read-Host 'Press Enter to close'
  exit 1
}
Ok ('Node: ' + $node)

# --- start the desk ----------------------------------------------------------
Say ''
Say 'Starting the desk...'
Push-Location $ROOT
& $node (Join-Path $ROOT 'start-background.js')
$deskCode = $LASTEXITCODE
Pop-Location

if ($deskCode -ne 0) {
  Say ''
  Bad 'The desk did not come up.'
  Say '  What it said is in: scratch\desk.log'
  Say ''
  $log = Join-Path $ROOT 'scratch\desk.log'
  if (Test-Path $log) {
    Say '  Last few lines:'
    Get-Content $log -Tail 12 -ErrorAction SilentlyContinue | ForEach-Object { Say ('    ' + $_) }
  }
  Say ''
  Read-Host 'Press Enter to close'
  exit 1
}
Ok 'desk running'

# --- start the tray ----------------------------------------------------------
Say ''
Say 'Starting the tray icon...'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'restart-tray.ps1')

Say ''
Say 'Done. Meters are by the clock; the page is at http://127.0.0.1:8775/'
Say ''
Start-Sleep -Seconds 4
exit 0
