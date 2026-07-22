# Riah Usage tray -- meters by the clock. Windows only, zero installs.
#
# Left-click icon : show the meters box, pinned, just above the tray icon.
#                   Click again (or click the box) to dismiss. NEVER the website.
# Hover icon      : same box, unpinned (polled via icon rect -- Win11 MouseMove
#                   is flaky). Move onto the box via the bridge; leaving hides it.
# Right-click     : menu, incl. "Open Riah Usage" (the only route to the site).
# Drag the box    : repositions it; the spot is saved to scratch\tray-pos.json,
#                   and is ignored again if it ever points at a different monitor.
# No Windows tooltip, ever: NotifyIcon.Text stays empty (a space still shows a
# bubble). See Clear-TrayTip.
#
# Placement rule: the box belongs on WHICHEVER MONITOR HOLDS THE TRAY ICON, and
# is forced there at the OS level (SetWindowPos) because WinForms bounds and the
# real window can disagree. Every show logs the icon rect, the target, and what
# the OS says actually happened -- read scratch\tray.log if it goes missing.
#
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1).

$ErrorActionPreference = 'SilentlyContinue'
$script:HasNative = $false
$script:DpiAware = $false

# Log path + logger must exist BEFORE the STA relaunch and the single-instance
# check, so a silent duplicate-instance exit still leaves a trace.
$script:Root    = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$script:LogPath = Join-Path $script:Root 'scratch\tray.log'

function Write-TrayLog([string]$msg) {
  try {
    $dir = Split-Path -Parent $script:LogPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $script:LogPath -Value $line -Encoding ASCII
  } catch {}
}

if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') {
  # -ArgumentList joins the array with spaces and adds NO quoting of its own, so
  # a bare path breaks on any folder with spaces in its name. Quote it exactly
  # once, the same way Start-Desk already does for the .vbs below.
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA',
    '-File', ('"{0}"' -f $PSCommandPath)
  ) | Out-Null
  exit 0
}

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'RiahUsageTray', [ref]$created)
if (-not $created) {
  # Another tray is already live. Say so instead of vanishing silently, or a
  # "restart" that did not really restart looks like a broken popup.
  Write-TrayLog 'exit_duplicate_instance'
  exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Port      = 8775
if ($env:RIAH_USAGE_PORT) { try { $script:Port = [int]$env:RIAH_USAGE_PORT } catch {} }
$script:BaseUrl   = 'http://127.0.0.1:{0}' -f $script:Port
$script:Data      = $null
$script:DeskUp    = $false
# Never use [datetime]::MinValue in age math -- use $script:LongAgo instead.
$script:LongAgo  = (Get-Date).AddDays(-1)
$script:FetchedAt = $script:LongAgo
$script:LastHover = $script:LongAgo
$script:HiddenAt  = $script:LongAgo
$script:IconHandle = [IntPtr]::Zero
$script:PopupOpen = $false
$script:DidBalloon = $false
$script:LeaveAt = $null
$script:Dragging = $false
$script:DragStart = $null
$script:DragOrigin = $null
$script:DidDrag = $false
$script:SavedPos = $null
$script:PosPath = Join-Path $script:Root 'scratch\tray-pos.json'
$script:IconHoverSignal = $script:LongAgo
$script:LoggedRectNull = $false
$script:LoggedMouseMove = $false
$script:PinnedUntil = $script:LongAgo
# Hover suppression: after a click dismiss, hover must NOT instantly re-open the
# box. SuppressUntil is a time floor; NeedsLeave forces the pointer to actually
# leave the icon first. Without these, click-to-close hid and re-showed in ~50ms
# and looked like the click did nothing at all.
$script:SuppressUntil = $script:LongAgo
$script:NeedsLeave = $false
$script:LastPlace = 'none'
# Last time we ATTEMPTED a data fetch, success or not -- see Test-DataStale.
$script:LastTry = $script:LongAgo
# Re-show governor. If the window ever refuses to stay visible, the pinned
# branch of the hover timer must not be able to spin on it 20x a second.
$script:LastShowAt = $script:LongAgo
$script:ReshowStrikes = 0
$RESHOW_GAP_MS = 300
$RESHOW_MAX = 5
$EDGE_GAP = 16
# Leave grace: half of the old 500ms hide + 900ms signal window felt like ~1s linger.
$HIDE_MS = 250
$SIGNAL_FRESH_MS = 450
$PIN_MS = 120000

# Full TypeDefinition is more reliable than -MemberDefinition for nested structs.
# If this fails, tray still runs with corner-hover fallback (no Shell_NotifyIconGetRect).
function Ensure-NativeType {
  if ('RiahTray.Native' -as [type]) {
    $script:HasNative = $true
    return $true
  }
  $src = @'
using System;
using System.Runtime.InteropServices;
namespace RiahTray {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    public struct NOTIFYICONIDENTIFIER {
      public uint cbSize;
      public IntPtr hWnd;
      public uint uID;
      public Guid guidItem;
    }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
      int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("shell32.dll", SetLastError=true)]
    public static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER identifier, out RECT iconLocation);
  }
}
'@
  try {
    Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
    $script:HasNative = [bool]('RiahTray.Native' -as [type])
  } catch {
    $script:HasNative = [bool]('RiahTray.Native' -as [type])
    if (-not $script:HasNative) {
      Write-TrayLog ('native_type_fail: ' + $_.Exception.Message)
    }
  }
  return $script:HasNative
}

# Never show the ugly .NET "Unhandled exception" dialog -- log and keep going.
try {
  [System.Windows.Forms.Application]::SetUnhandledExceptionMode(
    [System.Windows.Forms.UnhandledExceptionMode]::CatchException
  )
  [System.Windows.Forms.Application]::add_ThreadException({
    param($sender, $e)
    try { Write-TrayLog ('thread_exception: ' + $e.Exception.Message) } catch {}
  })
  [System.AppDomain]::CurrentDomain.add_UnhandledException({
    param($sender, $e)
    try { Write-TrayLog ('unhandled: ' + $e.ExceptionObject.ToString()) } catch {}
  })
} catch {}

Write-TrayLog 'starting'
Ensure-NativeType | Out-Null
if ($script:HasNative) {
  try { $script:DpiAware = [RiahTray.Native]::SetProcessDPIAware() } catch {}
}
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-ScreenForPoint([System.Drawing.Point]$pt) {
  # Screen.FromPoint snaps an off-screen point to the NEAREST monitor, which
  # silently hides "this coordinate is on no monitor at all". This does not.
  try {
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      if ($s.Bounds.Contains($pt)) { return $s }
    }
  } catch {}
  return $null
}

function Log-Environment {
  # Written once per start. This is the record that tells us WHICH monitor the
  # tray icon is on versus where the box landed.
  try {
    $i = 0
    foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
      $b = $s.Bounds
      $w = $s.WorkingArea
      Write-TrayLog ('screen[' + $i + '] primary=' + $s.Primary +
        ' bounds=' + $b.Left + ',' + $b.Top + ' ' + $b.Width + 'x' + $b.Height +
        ' work=' + $w.Left + ',' + $w.Top + ' ' + $w.Width + 'x' + $w.Height)
      $i++
    }
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    Write-TrayLog ('virtual ' + $vs.Left + ',' + $vs.Top + ' ' + $vs.Width + 'x' + $vs.Height +
      ' dpiaware=' + $script:DpiAware + ' native=' + $script:HasNative)
  } catch {}
}

# Match the desk page (index.html :root) so the tray feels like Riah Usage.
$C = @{
  Bg     = [System.Drawing.Color]::FromArgb(15, 15, 17)       # --bg #0F0F11
  Raised = [System.Drawing.Color]::FromArgb(20, 20, 23)       # --bg-raised
  Border = [System.Drawing.Color]::FromArgb(50, 50, 54)       # --rule-strong
  Hard   = [System.Drawing.Color]::FromArgb(237, 237, 239)    # --rule-hard
  Text   = [System.Drawing.Color]::FromArgb(237, 237, 239)    # --ink
  Dim    = [System.Drawing.Color]::FromArgb(154, 154, 162)    # --body
  Faint  = [System.Drawing.Color]::FromArgb(119, 119, 127)    # --dim
  Track  = [System.Drawing.Color]::FromArgb(40, 40, 44)
  Ok     = [System.Drawing.Color]::FromArgb(63, 207, 127)     # --keep
  Warn   = [System.Drawing.Color]::FromArgb(233, 186, 69)     # --revise
  Hot    = [System.Drawing.Color]::FromArgb(242, 109, 91)     # --discard
  Brand  = [System.Drawing.Color]::FromArgb(255, 92, 168)     # --riah-brand
}

# Point-size fonts. Compact (swipe note: Exact mirror was too big).
# Brand line uses Georgia italic as a close stand-in for Instrument Serif (tray has no web fonts).
$F = @{
  Brand = New-Object System.Drawing.Font('Georgia', 11, ([System.Drawing.FontStyle]::Bold -bor [System.Drawing.FontStyle]::Italic))
  Product = New-Object System.Drawing.Font('Georgia', 10, [System.Drawing.FontStyle]::Regular)
  Name  = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  Meta  = New-Object System.Drawing.Font('Consolas', 7)
  Meter = New-Object System.Drawing.Font('Segoe UI', 8)
  Foot  = New-Object System.Drawing.Font('Consolas', 7)
}

# Compact geometry -- swipe: "a bit too big" on Exact mirror.
$PAD = 10
$TITLE_H = 28
$NAME_H = 18
$METER_H = 16
$GAP = 6
$CARD_PAD = 6
$FOOT_H = 0
$BAR_H = 2
$LABEL_W = 52
$WIN_W = 268
$RULE_GAP = 6

function Get-PctColor([int]$p) {
  if ($p -ge 85) { return $C.Hot }
  if ($p -ge 60) { return $C.Warn }
  return $C.Ok
}

function Short-Meter([string]$label) {
  # Real words, not stumps. The label column is wider than the longest of these,
  # so "Fable" and "Week" cost nothing that "Fab" and "Wk" were buying. Only
  # shorten where a full word genuinely will not fit.
  $l = ([string]$label).Trim()
  if ($l -match '(?i)^5[- ]?hour') { return '5h' }
  if ($l -match '(?i)^weekly') { return 'Week' }
  if ($l -match '(?i)^current') { return 'Now' }
  if ($l -match '(?i)build') { return 'Build' }
  if ($l -match '(?i)^plan') { return 'Plan' }
  if ($l -match '(?i)^auto') { return 'Auto' }
  if ($l -match '(?i)^api') { return 'API' }
  if ($l -match '(?i)fable') { return 'Fable' }
  if ($l -match '(?i)credit') { return 'Credit' }
  if ($l -match '(?i)chat') { return 'Chat' }
  if ($l.Length -le 8) { return $l }
  return $l.Substring(0, 8)
}

function Get-Providers {
  if (-not $script:Data -or -not $script:Data.providers) { return ,@() }
  # Honour "Shown on the board" — unchecked names live in data.hidden (synced
  # from the web page). Without this filter the hover kept listing Gemini after
  # Captain hid it on the desk. (2026-07-21)
  $hidden = @{}
  try {
    if ($script:Data.hidden) {
      foreach ($n in @($script:Data.hidden)) {
        if ($null -ne $n -and [string]$n -ne '') {
          $hidden[[string]$n.ToLowerInvariant()] = $true
        }
      }
    }
  } catch {}
  $out = New-Object System.Collections.ArrayList
  foreach ($p in @($script:Data.providers)) {
    $name = ''
    try { $name = [string]$p.shortName } catch {}
    if ($name -and $hidden.ContainsKey($name.ToLowerInvariant())) { continue }
    [void]$out.Add($p)
  }
  return , @($out.ToArray())
}

function Get-WorstMeters {
  $list = New-Object System.Collections.ArrayList
  foreach ($p in (Get-Providers)) {
    $meters = @(); if ($p.meters) { $meters = @($p.meters) }
    if ($meters.Count -eq 0) { continue }
    $w = 0
    foreach ($m in $meters) {
      $v = 0; try { $v = [int]$m.usedPercent } catch {}
      if ($v -gt $w) { $w = $v }
    }
    if ($w -gt 100) { $w = 100 }
    [void]$list.Add(@{ name = [string]$p.shortName; pct = $w })
  }
  return , @($list.ToArray() | Sort-Object { $_.pct } -Descending)
}

function Update-TrayIcon {
  $asset = Join-Path (Split-Path -Parent $PSScriptRoot) 'assets\riah-usage-32.png'
  if (Test-Path -LiteralPath $asset) {
    $src = $null
    $bmp = $null
    $g = $null
    try {
      $src = [System.Drawing.Image]::FromFile($asset)
      $bmp = New-Object System.Drawing.Bitmap(32, 32)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, 32, 32)
      $g.Dispose(); $g = $null
      $src.Dispose(); $src = $null
      $h = $bmp.GetHicon()
      $notify.Icon = [System.Drawing.Icon]::FromHandle($h)
      if ($script:HasNative -and $script:IconHandle -ne [IntPtr]::Zero) {
        try { [RiahTray.Native]::DestroyIcon($script:IconHandle) | Out-Null } catch {}
      }
      $script:IconHandle = $h
      $bmp.Dispose(); $bmp = $null
      return
    } catch {
      try { if ($null -ne $g) { $g.Dispose() } } catch {}
      try { if ($null -ne $src) { $src.Dispose() } } catch {}
      try { if ($null -ne $bmp) { $bmp.Dispose() } } catch {}
      Write-TrayLog ('icon_asset_fail ' + $_.Exception.Message)
    }
  }
  $bmp = New-Object System.Drawing.Bitmap(32, 32)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $bg = New-Object System.Drawing.SolidBrush($C.Bg)
  $g.FillRectangle($bg, 1, 1, 30, 30)
  $pen = New-Object System.Drawing.Pen($C.Border)
  $g.DrawRectangle($pen, 1, 1, 29, 29)
  $tops = Get-WorstMeters
  if (-not $script:DeskUp -or $tops.Count -eq 0) {
    $tb = New-Object System.Drawing.SolidBrush($C.Track)
    $g.FillRectangle($tb, 6, 8, 20, 4)
    $g.FillRectangle($tb, 6, 14, 20, 4)
    $g.FillRectangle($tb, 6, 20, 20, 4)
    $tb.Dispose()
  } else {
    $y = 8
    $n = [Math]::Min(3, $tops.Count)
    for ($k = 0; $k -lt $n; $k++) {
      $tb = New-Object System.Drawing.SolidBrush($C.Track)
      $g.FillRectangle($tb, 6, $y, 20, 4)
      $tb.Dispose()
      $pct = [int]$tops[$k].pct
      if ($pct -gt 100) { $pct = 100 }
      $fw = [int][Math]::Round(20 * ($pct / 100.0))
      if ($pct -gt 0 -and $fw -lt 2) { $fw = 2 }
      if ($fw -gt 0) {
        $fb = New-Object System.Drawing.SolidBrush((Get-PctColor $pct))
        $g.FillRectangle($fb, 6, $y, $fw, 4)
        $fb.Dispose()
      }
      $y += 6
    }
  }
  $pen.Dispose(); $bg.Dispose(); $g.Dispose()
  $h = $bmp.GetHicon()
  $notify.Icon = [System.Drawing.Icon]::FromHandle($h)
  if ($script:HasNative -and $script:IconHandle -ne [IntPtr]::Zero) {
    try { [RiahTray.Native]::DestroyIcon($script:IconHandle) | Out-Null } catch {}
  }
  $script:IconHandle = $h
  $bmp.Dispose()
}

function Clear-TrayTip {
  # No Windows hover tooltip -- only our meters Form. Empty Text = no tip.
  # (A space still shows an empty tip bubble; never do that.)
  try { $notify.Text = [string]::Empty } catch {}
}

function Update-Tray {
  Clear-TrayTip
  Update-TrayIcon
  Clear-TrayTip
}

function Test-DataStale {
  # Two gates, both required. The floor is the important one: it stamps every
  # ATTEMPT, so a desk that is DOWN gets retried on a timer instead of on every
  # single show. Without it, a down desk meant a blocking web call on the UI
  # thread every time the box was drawn -- which froze the tray solid.
  if (((Get-Date) - $script:LastTry).TotalSeconds -lt 15) { return $false }
  return (((Get-Date) - $script:FetchedAt).TotalSeconds -gt 60)
}

function Load-Data {
  $script:LastTry = Get-Date
  try {
    $resp = Invoke-WebRequest -Uri ($script:BaseUrl + '/usage-data.js') -UseBasicParsing -TimeoutSec 2
    $raw = [string]$resp.Content
    $i = $raw.IndexOf('{'); $j = $raw.LastIndexOf('}')
    if ($i -lt 0 -or $j -le $i) { throw 'no json' }
    $parsed = $raw.Substring($i, $j - $i + 1) | ConvertFrom-Json
    if ($parsed) {
      $script:Data = $parsed
      $script:DeskUp = $true
      $script:FetchedAt = Get-Date
    } else { $script:DeskUp = $false }
  } catch { $script:DeskUp = $false }
  Update-Tray
  # Early hover can open a tiny stub box before meters load -- resize once data is in
  if (Test-PopupShown) {
    try {
      $w = Place-Popup
      Force-PopupOnScreen $w[0] $w[1] $w[2] $w[3]
      $popup.Invalidate()
      $popup.BringToFront()
    } catch {}
  }
}

function Measure-ContentHeight {
  $h = $PAD + $TITLE_H + $RULE_GAP + 18
  if (-not $script:DeskUp) { return $h + 48 + $PAD }
  $prov = Get-Providers
  if ($prov.Count -eq 0) { return $h + 32 + $PAD }
  foreach ($p in $prov) {
    $meters = @(); if ($p.meters) { $meters = @($p.meters) }
    $meterRows = if ($meters.Count -eq 0) { 1 } else { $meters.Count }
    $h += $CARD_PAD + $NAME_H + ($METER_H * $meterRows) + $CARD_PAD + $GAP
  }
  $h += $FOOT_H + $PAD
  return $h
}

function Load-SavedPos {
  # A half-written or empty file used to become 0,0 via [int]$null. Demand real
  # numbers; anything else means "no saved spot", not "put it in the corner".
  try {
    $script:SavedPos = $null
    if (-not (Test-Path $script:PosPath)) { return }
    $j = Get-Content -Path $script:PosPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $j) { return }
    if ($null -eq $j.x -or $null -eq $j.y) { return }
    $x = [int]$j.x; $y = [int]$j.y
    $script:SavedPos = New-Object System.Drawing.Point($x, $y)
    Write-TrayLog ('savedpos_loaded ' + $x + ',' + $y)
  } catch {
    $script:SavedPos = $null
  }
}

function Clear-SavedPos([string]$why) {
  $script:SavedPos = $null
  try { '{}' | Set-Content -Path $script:PosPath -Encoding ASCII } catch {}
  Write-TrayLog ('savedpos_cleared ' + $why)
}

function Clamp-ToScreen($scr, [int]$x, [int]$y, [int]$w, [int]$h) {
  # Clamp against ONE named screen, never "whichever screen is nearest".
  $wa = $scr.WorkingArea
  if ($x + $w -gt $wa.Right - 4) { $x = $wa.Right - $w - 4 }
  if ($y + $h -gt $wa.Bottom - 4) { $y = $wa.Bottom - $h - 4 }
  if ($x -lt $wa.Left + 4) { $x = $wa.Left + 4 }
  if ($y -lt $wa.Top + 4) { $y = $wa.Top + 4 }
  return ,@($x, $y)
}

function Save-PopupPos {
  try {
    $dir = Split-Path -Parent $script:PosPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $o = @{ x = [int]$popup.Left; y = [int]$popup.Top }
    ($o | ConvertTo-Json -Compress) | Set-Content -Path $script:PosPath -Encoding ASCII
    $script:SavedPos = New-Object System.Drawing.Point($popup.Left, $popup.Top)
  } catch {}
}

function Clamp-ToWorkingArea([int]$x, [int]$y, [int]$w, [int]$h) {
  $scr = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($x, $y)))
  if (-not $scr) { $scr = [System.Windows.Forms.Screen]::PrimaryScreen }
  $wa = $scr.WorkingArea
  if ($x + $w -gt $wa.Right - 4) { $x = $wa.Right - $w - 4 }
  if ($y + $h -gt $wa.Bottom - 4) { $y = $wa.Bottom - $h - 4 }
  if ($x -lt $wa.Left + 4) { $x = $wa.Left + 4 }
  if ($y -lt $wa.Top + 4) { $y = $wa.Top + 4 }
  return ,@($x, $y)
}

function Place-Popup {
  # Everything hangs off ONE decision: which monitor is the tray icon on. The
  # box then lives on that monitor and nowhere else. A saved drag position that
  # points at a different monitor is thrown away rather than obeyed.
  $contentH = Measure-ContentHeight
  $winW = $WIN_W
  $icon = Get-IconRectRaw

  $scr = $null
  $anchor = $null
  if ($null -ne $icon) {
    $anchor = New-Object System.Drawing.Point(
      ($icon.Left + [int]($icon.Width / 2)),
      $icon.Top
    )
    $scr = Get-ScreenForPoint $anchor
  }
  if ($null -eq $scr) {
    $cp = [System.Windows.Forms.Cursor]::Position
    $s2 = Get-ScreenForPoint $cp
    if ($null -ne $s2) {
      $scr = $s2
      if ($null -eq $anchor) { $anchor = $cp }
    }
  }
  if ($null -eq $scr) { $scr = [System.Windows.Forms.Screen]::PrimaryScreen }
  $wa = $scr.WorkingArea
  if ($null -eq $anchor) {
    $anchor = New-Object System.Drawing.Point(($wa.Right - 60), $wa.Bottom)
  }

  $winH = [Math]::Min([Math]::Max($contentH, 120), [int]($wa.Height * 0.9))

  $src = 'icon'
  if ($script:SavedPos) {
    $cx = $script:SavedPos.X + [int]($winW / 2)
    $cy = $script:SavedPos.Y + [int]($winH / 2)
    $savedScr = Get-ScreenForPoint (New-Object System.Drawing.Point($cx, $cy))
    if ($null -ne $savedScr -and $savedScr.DeviceName -eq $scr.DeviceName) {
      $src = 'saved'
    } else {
      Clear-SavedPos ('off_icon_screen ' + $script:SavedPos.X + ',' + $script:SavedPos.Y)
    }
  }

  if ($src -eq 'saved') {
    $x = $script:SavedPos.X
    $y = $script:SavedPos.Y
  } else {
    $x = $anchor.X - [int]($winW / 2)
    $y = $anchor.Y - $winH - 10
  }
  $xy = Clamp-ToScreen $scr $x $y $winW $winH
  $x = $xy[0]; $y = $xy[1]

  $iconTxt = 'null'
  if ($null -ne $icon) {
    $iconTxt = '' + $icon.Left + ',' + $icon.Top + ' ' + $icon.Width + 'x' + $icon.Height
  }
  $script:LastPlace = 'src=' + $src + ' icon=' + $iconTxt +
    ' work=' + $wa.Left + ',' + $wa.Top + ' ' + $wa.Width + 'x' + $wa.Height +
    ' want=' + $x + ',' + $y + ' ' + $winW + 'x' + $winH

  $popup.SetBounds($x, $y, $winW, $winH)
  return ,@($x, $y, $winW, $winH)
}

function Get-NotifyPrivate([string[]]$names) {
  $flags = [System.Reflection.BindingFlags]'Instance, NonPublic'
  $t = $notify.GetType()
  foreach ($n in $names) {
    $f = $t.GetField($n, $flags)
    if ($f) { return $f.GetValue($notify) }
  }
  return $null
}

function Get-IconRectRaw {
  # The TRUE icon box from Windows, unpadded. Placement uses this one; the
  # padded version below is only for forgiving hover hit-testing.
  if (-not $script:HasNative) { return $null }
  try {
    $idObj = Get-NotifyPrivate @('id', 'Id')
    $win = Get-NotifyPrivate @('window', 'Window')
    if ($null -eq $idObj -or -not $win) { return $null }
    $id = [uint32]$idObj
    $hwnd = $win.Handle
    if ($hwnd -eq [IntPtr]::Zero) { return $null }
    $nid = New-Object 'RiahTray.Native+NOTIFYICONIDENTIFIER'
    $nid.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf($nid)
    $nid.hWnd = $hwnd
    $nid.uID = $id
    $nid.guidItem = [guid]::Empty
    $rc = New-Object 'RiahTray.Native+RECT'
    $hr = [RiahTray.Native]::Shell_NotifyIconGetRect([ref]$nid, [ref]$rc)
    if ($hr -ne 0) { return $null }
    # Reject empty / absurd rects (common when icon is collapsed into overflow)
    $rw = $rc.Right - $rc.Left
    $rh = $rc.Bottom - $rc.Top
    if ($rw -lt 4 -or $rh -lt 4 -or $rw -gt 160 -or $rh -gt 160) { return $null }
    return New-Object System.Drawing.Rectangle($rc.Left, $rc.Top, $rw, $rh)
  } catch {
    return $null
  }
}

function Get-TrayIconRect {
  # Padded hover target so the pointer does not have to be pixel-perfect --
  # but ASYMMETRIC, and the top pad is the whole point.
  #
  # It used to pad 18px on every side. Above the tray icon is where Windows
  # opens the "more icons" overflow panel, so that upward padding sat right on
  # top of the flyout's bottom row: reaching for any hidden icon down there
  # opened the meters box instead. Sideways forgiveness is free; upward
  # forgiveness costs you the overflow panel. (Captain, 2026-07-20)
  $r = Get-IconRectRaw
  if ($null -eq $r) { return $null }
  $padX = 8
  $padTop = 2
  $padBottom = 8
  return New-Object System.Drawing.Rectangle(
    ($r.Left - $padX), ($r.Top - $padTop),
    ($r.Width + 2 * $padX), ($r.Height + $padTop + $padBottom)
  )
}

function Test-OverTrayIcon([System.Drawing.Point]$pos) {
  $r = Get-TrayIconRect
  if ($null -ne $r -and $r.Contains($pos)) { return $true }
  return $false
}

function Test-OverPopup([System.Drawing.Point]$pos) {
  if (-not $popup.Visible -and -not $script:PopupOpen) { return $false }
  try {
    $b = $popup.Bounds
    $b.Inflate(10, 10)
    return $b.Contains($pos)
  } catch {
    return $false
  }
}

function Test-OverBridge([System.Drawing.Point]$pos) {
  # Thin path from icon to popup so you can move onto the box without it vanishing.
  if (-not $popup.Visible) { return $false }
  $icon = Get-TrayIconRect
  if ($null -eq $icon) { return $false }
  try {
    $b = $popup.Bounds
    $left = [Math]::Min($icon.Left, $b.Left) - 6
    $right = [Math]::Max($icon.Right, $b.Right) + 6
    $top = [Math]::Min($icon.Top, $b.Top) - 6
    $bottom = [Math]::Max($icon.Bottom, $b.Bottom) + 6
    # Keep the bridge narrow: only the strip between the two, not a giant fill.
    $mid = New-Object System.Drawing.Rectangle($left, $top, ($right - $left), ($bottom - $top))
    if (-not $mid.Contains($pos)) { return $false }
    # Accept only if close to the line between icon center and popup center
    $icx = $icon.Left + [int]($icon.Width / 2)
    $icy = $icon.Top + [int]($icon.Height / 2)
    $pcx = $b.Left + [int]($b.Width / 2)
    $pcy = $b.Top + [int]($b.Height / 2)
    # Distance from point to segment (approx via bounding fat line)
    $pad = 28
    $seg = New-Object System.Drawing.Rectangle(
      ([Math]::Min($icx, $pcx) - $pad),
      ([Math]::Min($icy, $pcy) - $pad),
      ([Math]::Abs($icx - $pcx) + 2 * $pad),
      ([Math]::Abs($icy - $pcy) + 2 * $pad)
    )
    return $seg.Contains($pos)
  } catch {
    return $false
  }
}

function Test-Pinned {
  return ((Get-Date) -lt $script:PinnedUntil)
}

function Test-PopupShown {
  # Ground truth = what the OS says about the window, not a flag we set. The old
  # code trusted a stale flag, so a click could "toggle off" a box that was
  # never really on screen.
  try {
    if (-not $popup.Visible) { return $false }
    if ($script:HasNative) {
      $h = $popup.Handle
      if ($h -ne [IntPtr]::Zero) {
        if (-not [RiahTray.Native]::IsWindowVisible($h)) { return $false }
      }
    }
    return $true
  } catch { return $false }
}

function Get-WindowFacts {
  $txt = 'managed=' + $popup.Left + ',' + $popup.Top + ' ' +
         $popup.Width + 'x' + $popup.Height + ' vis=' + $popup.Visible
  if ($script:HasNative) {
    try {
      $h = $popup.Handle
      $rc = New-Object 'RiahTray.Native+RECT'
      if ([RiahTray.Native]::GetWindowRect($h, [ref]$rc)) {
        $txt = $txt + ' os=' + $rc.Left + ',' + $rc.Top + ' ' +
               ($rc.Right - $rc.Left) + 'x' + ($rc.Bottom - $rc.Top)
      } else {
        $txt = $txt + ' os=fail'
      }
      $txt = $txt + ' osvis=' + [RiahTray.Native]::IsWindowVisible($h)
    } catch { $txt = $txt + ' os=err' }
  }
  return $txt
}

function Force-PopupOnScreen([int]$x, [int]$y, [int]$w, [int]$h) {
  # Put the window exactly there at the OS level, on top, without stealing
  # focus. WinForms bounds can disagree with the real window; this settles it.
  if (-not $script:HasNative) { return }
  try {
    $hw = $popup.Handle
    if ($hw -eq [IntPtr]::Zero) { return }
    $topMost = New-Object IntPtr(-1)
    $flags = [uint32](0x0040 -bor 0x0010)   # SWP_SHOWWINDOW | SWP_NOACTIVATE
    [void][RiahTray.Native]::SetWindowPos($hw, $topMost, $x, $y, $w, $h, $flags)

    # Win the topmost band. Captain cannot close Task Manager (closing it pins
    # his CPU at 100%), and Task Manager is always-on-top too -- so the box was
    # opening UNDERNEATH it. Among topmost windows the last one to assert wins,
    # and asserting once while placing is not enough. Ask again, position-only,
    # still without stealing focus.
    $reassert = [uint32](0x0001 -bor 0x0002 -bor 0x0040 -bor 0x0010)  # NOSIZE|NOMOVE|SHOWWINDOW|NOACTIVATE
    [void][RiahTray.Native]::SetWindowPos($hw, $topMost, 0, 0, 0, 0, $reassert)
  } catch {}
}

function Ensure-PopupSeen {
  # Last line of defence: if the real window is hidden, collapsed, or sitting on
  # no monitor at all, drop it dead centre on the main screen. Better an
  # unexpected place than an invisible one.
  if (-not $script:HasNative) { return }
  try {
    $hw = $popup.Handle
    $rc = New-Object 'RiahTray.Native+RECT'
    $got = [RiahTray.Native]::GetWindowRect($hw, [ref]$rc)
    $bad = $false
    if (-not $got -or -not [RiahTray.Native]::IsWindowVisible($hw)) {
      $bad = $true
    } else {
      $w = $rc.Right - $rc.Left
      $h = $rc.Bottom - $rc.Top
      if ($w -lt 40 -or $h -lt 40) {
        $bad = $true
      } else {
        $ctr = New-Object System.Drawing.Point(
          ($rc.Left + [int]($w / 2)), ($rc.Top + [int]($h / 2)))
        if ($null -eq (Get-ScreenForPoint $ctr)) { $bad = $true }
      }
    }
    if (-not $bad) { return }

    $scr = [System.Windows.Forms.Screen]::PrimaryScreen
    $wa = $scr.WorkingArea
    $w2 = $popup.Width
    $h2 = $popup.Height
    if ($w2 -lt 40) { $w2 = $WIN_W }
    if ($h2 -lt 40) { $h2 = 200 }
    $x2 = $wa.Left + [int](($wa.Width - $w2) / 2)
    $y2 = $wa.Top + [int](($wa.Height - $h2) / 2)
    $popup.SetBounds($x2, $y2, $w2, $h2)
    Force-PopupOnScreen $x2 $y2 $w2 $h2
    Clear-SavedPos 'rescue'
    Write-TrayLog ('rescue_center ' + (Get-WindowFacts))
  } catch {}
}

function Suppress-Hover([int]$ms) {
  $script:SuppressUntil = (Get-Date).AddMilliseconds($ms)
  $script:NeedsLeave = $true
}

function Test-HoverBlocked {
  if ((Get-Date) -lt $script:SuppressUntil) { return $true }
  if ($script:NeedsLeave) { return $true }
  return $false
}

# Only a real taskbar surface may host the hover peek. When a fullscreen app
# (YouTube, a game) covers the clock corner, the window under the cursor is
# that app, not the taskbar -- and the peek must stay quiet. The icon rect
# poll cannot tell the difference; the window under the cursor can.
# (Captain, 2026-07-21: it should only pop up when the taskbar is visible.)
function Test-TaskbarUnderCursor([System.Drawing.Point]$pos) {
  if (-not $script:HasNative) { return $true }  # corner-fallback rigs keep old behavior
  try {
    $pt = New-Object "RiahTray.Native+POINT"
    $pt.X = $pos.X
    $pt.Y = $pos.Y
    $h = [RiahTray.Native]::WindowFromPoint($pt)
    if ($h -eq [IntPtr]::Zero) { return $false }
    $root = [RiahTray.Native]::GetAncestor($h, 2)  # 2 = GA_ROOT
    if ($root -eq [IntPtr]::Zero) { $root = $h }
    $sb = New-Object System.Text.StringBuilder 256
    [void][RiahTray.Native]::GetClassName($root, $sb, 256)
    $cls = $sb.ToString()
    if ($cls -eq 'Shell_TrayWnd') { return $true }             # main taskbar
    if ($cls -eq 'Shell_SecondaryTrayWnd') { return $true }    # taskbar on other monitors
    if ($cls -eq 'NotifyIconOverflowWindow') { return $true }  # Win10 overflow flyout
    if ($cls -like 'TopLevelWindowForOverflowXamlIsland*') { return $true }  # Win11 overflow
    return $false
  } catch {
    return $true  # a broken guard must never kill hover outright
  }
}

function Request-HoverShow {
  if (Test-HoverBlocked) { return }
  if (-not (Test-PopupShown)) { Show-Popup }
}

function Show-Popup {
  try {
    Clear-TrayTip
    if (Test-PopupShown) {
      $script:LeaveAt = $null
      $popup.Invalidate()
      $popup.BringToFront()
      return
    }
    # No debounce here any more. Hover re-entry is gated by Test-HoverBlocked,
    # so a show request that gets this far is one we actually want.
    if (Test-DataStale) { Load-Data }
    $want = Place-Popup
    $script:PopupOpen = $true
    $script:LeaveAt = $null
    # Off-then-on forces WinForms to re-register the topmost style rather than
    # deciding nothing changed. Belt to Force-PopupOnScreen's braces.
    $popup.TopMost = $false
    $popup.TopMost = $true
    $popup.Invalidate()
    $popup.Show()
    Force-PopupOnScreen $want[0] $want[1] $want[2] $want[3]
    $popup.BringToFront()
    Clear-TrayTip
    $script:LastShowAt = Get-Date
    Write-TrayLog ('show_ok ' + $script:LastPlace + ' | ' + (Get-WindowFacts))
    Ensure-PopupSeen
  } catch {
    $script:PopupOpen = $false
    Write-TrayLog ('show_fail: ' + $_.Exception.Message)
  }
}

function Hide-Popup {
  if ($script:Dragging) { return }
  if (Test-Pinned) { return }
  if (-not $popup.Visible -and -not $script:PopupOpen) { return }
  $script:PopupOpen = $false
  $script:LeaveAt = $null
  $script:HiddenAt = Get-Date
  try { $popup.Hide() } catch {}
}

function Dismiss-Popup {
  # Deliberate close (second click on the icon, or a click on the box itself).
  # Suppress-Hover is what makes it STICK while the pointer is still on the icon.
  $script:PinnedUntil = $script:LongAgo
  $script:PopupOpen = $false
  $script:LeaveAt = $null
  $script:HiddenAt = Get-Date
  Suppress-Hover 1500
  try { $popup.Hide() } catch {}
  Write-TrayLog 'dismissed'
}

function Show-PopupPinned {
  # Left-click path: stay up until click-again / click the box / pin expires
  $script:HiddenAt = $script:LongAgo
  $script:SuppressUntil = $script:LongAgo
  $script:NeedsLeave = $false
  $script:PinnedUntil = (Get-Date).AddMilliseconds($PIN_MS)
  $script:LeaveAt = $null
  Show-Popup
}

function Toggle-Popup {
  if (Test-PopupShown) {
    Dismiss-Popup
  } else {
    Show-PopupPinned
  }
}

function Open-Desk { try { Start-Process ($script:BaseUrl + '/') } catch {} }

function Start-Desk {
  try {
    $vbs = Join-Path $script:Root 'start-hidden.vbs'
    if (Test-Path $vbs) {
      Start-Process -FilePath 'wscript.exe' -ArgumentList '//B', '//Nologo', ('"{0}"' -f $vbs) -WorkingDirectory $script:Root
    } else {
      # A missing launcher must fail LOUDLY, not silently (ROADMAP move 3).
      Write-TrayLog ('startdesk_fail missing_vbs ' + $vbs)
      $notify.BalloonTipTitle = 'Riah Usage'
      $notify.BalloonTipText = 'Cannot start the desk: start-hidden.vbs is missing from the Riah Usage folder.'
      $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Error
      $notify.ShowBalloonTip(6000)
    }
    $script:KickTimer.Stop(); $script:KickTimer.Start()
  } catch {}
}

function Refresh-Now {
  try {
    Invoke-WebRequest -Uri ($script:BaseUrl + '/api/refresh') -Method POST -UseBasicParsing -TimeoutSec 2 | Out-Null
  } catch {}
  $script:KickTimer.Stop(); $script:KickTimer.Start()
}

function Quit-Tray {
  try { $hoverTimer.Stop(); $pollTimer.Stop(); $script:KickTimer.Stop() } catch {}
  try { $notify.Visible = $false; $notify.Dispose() } catch {}
  [System.Windows.Forms.Application]::Exit()
}

# --- popup form (more reliable than ToolStripDropDown for hit-testing) ---
$popup = New-Object System.Windows.Forms.Form
# The window title is never drawn (borderless), but Windows still reads it --
# Task Manager can group the process under this name instead of burying it as
# "Windows PowerShell". Costs nothing, so it is worth having either way.
$popup.Text = 'Riah Usage'
$popup.FormBorderStyle = 'None'
$popup.ShowInTaskbar = $false
$popup.StartPosition = 'Manual'
$popup.TopMost = $true
$popup.BackColor = $C.Bg
$popup.Cursor = [System.Windows.Forms.Cursors]::SizeAll
$db = $popup.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic')
if ($db) { $db.SetValue($popup, $true, $null) }
[void]$popup.Handle
Load-SavedPos

$popup.add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.Clear($C.Bg)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bText = New-Object System.Drawing.SolidBrush($C.Text)
  $bDim = New-Object System.Drawing.SolidBrush($C.Dim)
  $bFaint = New-Object System.Drawing.SolidBrush($C.Faint)
  $bRaised = New-Object System.Drawing.SolidBrush($C.Raised)
  $pen = New-Object System.Drawing.Pen($C.Border)
  [void]$g.DrawRectangle($pen, 0, 0, ($popup.ClientSize.Width - 1), ($popup.ClientSize.Height - 1))

  $y = $PAD
  # Wordmark: italic pink "Riah" + ink "Usage" (brand first -- always)
  # Measure real glyph height so italic descenders never clip the hard rule.
  $bBrand = New-Object System.Drawing.SolidBrush($C.Brand)
  $riahSize = $g.MeasureString('Riah', $F.Brand)
  $usageSize = $g.MeasureString(' Usage', $F.Product)
  $markH = [int][Math]::Ceiling([Math]::Max($riahSize.Height, $usageSize.Height))
  [void]$g.DrawString('Riah', $F.Brand, $bBrand, $PAD, $y)
  [void]$g.DrawString(' Usage', $F.Product, $bText, ($PAD + $riahSize.Width - 4), ($y + 1))
  $bBrand.Dispose()
  $y += $markH + $RULE_GAP
  $hardPen = New-Object System.Drawing.Pen($C.Hard, 2)
  [void]$g.DrawLine($hardPen, $PAD, $y, ($popup.ClientSize.Width - $PAD), $y)
  $hardPen.Dispose()
  $y += $RULE_GAP + 2

  # LIVE pill (desk twin)
  if ($script:DeskUp) {
    $dot = New-Object System.Drawing.SolidBrush($C.Ok)
    [void]$g.FillEllipse($dot, $PAD, ($y + 2), 6, 6)
    $dot.Dispose()
    [void]$g.DrawString('LIVE', $F.Meta, $bFaint, ($PAD + 10), $y)
  }
  $y += 14

  if (-not $script:DeskUp) {
    [void]$g.DrawString('Desk is not running.', $F.Name, $bText, $PAD, $y)
    [void]$g.DrawString('Right-click icon, Start desk', $F.Meter, $bDim, $PAD, ($y + 18))
  } else {
    $prov = Get-Providers
    if ($prov.Count -eq 0) {
      [void]$g.DrawString('No AIs connected yet.', $F.Name, $bText, $PAD, $y)
    } else {
      $innerL = $PAD
      $innerR = $popup.ClientSize.Width - $PAD
      $innerW = $innerR - $innerL
      foreach ($p in $prov) {
        $name = [string]$p.shortName
        if (-not $name) { $name = [string]$p.name }
        $meters = @()
        if ($p.meters) { $meters = @($p.meters) }
        $meterRows = if ($meters.Count -eq 0) { 1 } else { $meters.Count }
        $cardH = $CARD_PAD + $NAME_H + ($METER_H * $meterRows) + $CARD_PAD

        # Desk-style raised card
        [void]$g.FillRectangle($bRaised, $innerL, $y, $innerW, $cardH)
        [void]$g.DrawRectangle($pen, $innerL, $y, $innerW - 1, $cardH - 1)

        $cy = $y + $CARD_PAD
        [void]$g.DrawString($name, $F.Name, $bText, ($innerL + 6), $cy)

        # Mark a reading we could not refresh. The box showed a kept-back number
        # exactly like a live one, so a stale figure read as current truth.
        # (Captain, 2026-07-20: Claude weekly showed 79% when it was 91%.)
        $isStale = $false
        try { $isStale = [bool]$p.stale } catch {}
        if ($isStale) {
          $nameSz = $g.MeasureString($name, $F.Name)
          $bStale = New-Object System.Drawing.SolidBrush($C.Warn)
          [void]$g.DrawString('old', $F.Meta, $bStale, ($innerL + 8 + $nameSz.Width), ($cy + 3))
          $bStale.Dispose()
        }

        $plan = ''
        if ($p.plan) { $plan = [string]$p.plan }
        if ($plan) {
          $sz = $g.MeasureString($plan, $F.Meta)
          [void]$g.DrawString($plan, $F.Meta, $bFaint, ($innerR - 6 - $sz.Width), ($cy + 2))
        }
        $cy += $NAME_H

        if ($meters.Count -eq 0) {
          [void]$g.DrawString('no meters yet', $F.Meter, $bDim, ($innerL + 6), $cy)
        } else {
          foreach ($m in $meters) {
            $pct = 0
            try { $pct = [int]$m.usedPercent } catch {}
            if ($pct -lt 0) { $pct = 0 }
            if ($pct -gt 100) { $pct = 100 }

            $lab = Short-Meter ([string]$m.label)
            [void]$g.DrawString($lab, $F.Meta, $bDim, ($innerL + 6), $cy)

            $pctText = ('{0}%' -f $pct)
            $pctBrush = New-Object System.Drawing.SolidBrush((Get-PctColor $pct))
            $psz = $g.MeasureString($pctText, $F.Meter)
            $pctX = [int]($innerR - 6 - $psz.Width)
            [void]$g.DrawString($pctText, $F.Meter, $pctBrush, $pctX, $cy)

            $barX = $innerL + 6 + $LABEL_W
            $barW = [int]($pctX - $barX - 6)
            if ($barW -lt 28) { $barW = 28 }
            $barY = $cy + [int](($METER_H - $BAR_H) / 2) + 1
            $track = New-Object System.Drawing.SolidBrush($C.Track)
            [void]$g.FillRectangle($track, $barX, $barY, $barW, $BAR_H)
            $track.Dispose()
            $fw = [int][Math]::Round($barW * ($pct / 100.0))
            if ($pct -gt 0 -and $fw -lt 2) { $fw = 2 }
            if ($fw -gt 0) {
              $fill = New-Object System.Drawing.SolidBrush((Get-PctColor $pct))
              [void]$g.FillRectangle($fill, $barX, $barY, $fw, $BAR_H)
              $fill.Dispose()
            }
            $pctBrush.Dispose()
            $cy += $METER_H
          }
        }
        $y += $cardH + $GAP
      }
    }
  }

  $bText.Dispose(); $bDim.Dispose(); $bFaint.Dispose(); $bRaised.Dispose(); $pen.Dispose()
})

$popup.add_MouseDown({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $script:Dragging = $true
  $script:DidDrag = $false
  $script:DragStart = [System.Windows.Forms.Cursor]::Position
  $script:DragOrigin = New-Object System.Drawing.Point($popup.Left, $popup.Top)
  $script:LeaveAt = $null
})
$popup.add_MouseMove({
  param($s, $e)
  $script:LeaveAt = $null
  if (-not $script:Dragging) { return }
  $cur = [System.Windows.Forms.Cursor]::Position
  $dx = $cur.X - $script:DragStart.X
  $dy = $cur.Y - $script:DragStart.Y
  if (-not $script:DidDrag -and [Math]::Abs($dx) -lt 4 -and [Math]::Abs($dy) -lt 4) { return }
  $script:DidDrag = $true
  $nx = $script:DragOrigin.X + $dx
  $ny = $script:DragOrigin.Y + $dy
  $xy = Clamp-ToWorkingArea $nx $ny $popup.Width $popup.Height
  $popup.SetBounds($xy[0], $xy[1], $popup.Width, $popup.Height)
})
$popup.add_MouseUp({
  param($s, $e)
  if ($e.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
  $wasDrag = $script:DidDrag
  $script:Dragging = $false
  $script:DragStart = $null
  $script:DragOrigin = $null
  if ($wasDrag) {
    Save-PopupPos
    $script:DidDrag = $false
    return
  }
  $script:DidDrag = $false
  # Click (no drag) dismisses. Never opens the website.
  Dismiss-Popup
})
$popup.add_MouseEnter({ param($s, $e) $script:LeaveAt = $null })
$popup.add_MouseLeave({
  param($s, $e)
  if (-not $script:Dragging -and -not (Test-Pinned)) { $script:LeaveAt = Get-Date }
})

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = [string]::Empty
$notify.Visible = $false

# Build a real icon BEFORE making the tray icon visible (Windows hides icon-less NotifyIcons).
try {
  Update-TrayIcon
  Clear-TrayTip
} catch {
  Write-TrayLog ('icon_boot_fail ' + $_.Exception.Message)
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miMeters = $menu.Items.Add('Show meters')
$miMeters.add_Click({ param($s, $e) Show-PopupPinned })
$miOpen = $menu.Items.Add('Open Riah Usage')
$miOpen.add_Click({ param($s, $e) Open-Desk })
$miRefresh = $menu.Items.Add('Refresh now')
$miRefresh.add_Click({ param($s, $e) Refresh-Now })
$miStart = $menu.Items.Add('Start desk')
$miStart.add_Click({ param($s, $e) Start-Desk })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add('Quit tray')
$miQuit.add_Click({ param($s, $e) Quit-Tray })
$menu.add_Opening({ param($s, $e) $miStart.Enabled = (-not $script:DeskUp) })

$notify.add_MouseUp({
  param($s, $e)
  Clear-TrayTip
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $menu.Show([System.Windows.Forms.Cursor]::Position)
    return
  }
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    # Primary path: left-click opens/closes the meters Form (never the website)
    Write-TrayLog 'left_click'
    Toggle-Popup
  }
})

$notify.add_MouseMove({
  param($s, $e)
  Clear-TrayTip
  if (-not $script:LoggedMouseMove) {
    Write-TrayLog 'mousemove_ok'
    $script:LoggedMouseMove = $true
  }
  $script:IconHoverSignal = Get-Date
  if (Test-HoverBlocked) { return }
  $script:HiddenAt = $script:LongAgo
  $script:LeaveAt = $null
  Request-HoverShow
})

$notify.add_MouseDown({
  param($s, $e)
  Clear-TrayTip
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left -or
      $e.Button -eq [System.Windows.Forms.MouseButtons]::Right) {
    $script:IconHoverSignal = Get-Date
    $script:LeaveAt = $null
  }
})

# Balloon tip is only to surface a hidden tray icon -- never opens the site
$notify.add_BalloonTipClicked({ param($s, $e) Show-PopupPinned })

$hoverTimer = New-Object System.Windows.Forms.Timer
$hoverTimer.Interval = 50
$hoverTimer.add_Tick({
  param($s, $e)
  Clear-TrayTip
  if ($script:Dragging) {
    $script:LeaveAt = $null
    return
  }
  $pos = [System.Windows.Forms.Cursor]::Position
  $overIcon = Test-OverTrayIcon $pos
  $overPopup = Test-OverPopup $pos
  $overBridge = Test-OverBridge $pos

  # Release the "must leave first" latch only once the pointer is genuinely off
  # both the icon and the box. This is what stops a dismiss from bouncing back.
  if ($script:NeedsLeave -and -not $overIcon -and -not $overPopup) {
    if ((Get-Date) -ge $script:SuppressUntil) { $script:NeedsLeave = $false }
  }

  # Click-pinned: stay up; ignore hover-leave until pin ends or user toggles off
  if (Test-Pinned) {
    if (Test-PopupShown) {
      $script:ReshowStrikes = 0
    } elseif (((Get-Date) - $script:LastShowAt).TotalMilliseconds -ge $RESHOW_GAP_MS) {
      # Governed retry. A box that will not stay up is a bug to READ about in
      # the log, not something to hammer the machine over.
      if ($script:ReshowStrikes -lt $RESHOW_MAX) {
        $script:ReshowStrikes++
        Show-Popup
      } elseif ($script:ReshowStrikes -eq $RESHOW_MAX) {
        $script:ReshowStrikes++
        $script:PinnedUntil = $script:LongAgo
        Write-TrayLog ('reshow_gave_up after ' + $RESHOW_MAX + ' tries | ' + (Get-WindowFacts))
      }
    }
    $script:LeaveAt = $null
    return
  }

  $signalFresh = (((Get-Date) - $script:IconHoverSignal).TotalMilliseconds -lt $SIGNAL_FRESH_MS)

  if (-not $overIcon -and -not $script:LoggedRectNull) {
    $r = Get-TrayIconRect
    if ($null -eq $r) {
      Write-TrayLog ('icon_rect_null native=' + $script:HasNative)
      $script:LoggedRectNull = $true
    }
  }

  if (($overIcon -or $signalFresh) -and -not (Test-HoverBlocked) -and (Test-TaskbarUnderCursor $pos)) {
    $script:HiddenAt = $script:LongAgo
    $script:LeaveAt = $null
    Request-HoverShow
    return
  }

  if ((Test-PopupShown) -and ($overPopup -or $overBridge)) {
    $script:LeaveAt = $null
    return
  }

  if (-not (Test-PopupShown)) {
    $script:LeaveAt = $null
    $script:PopupOpen = $false
    return
  }

  if ($null -eq $script:LeaveAt) { $script:LeaveAt = Get-Date }
  if (((Get-Date) - $script:LeaveAt).TotalMilliseconds -ge $HIDE_MS) {
    Hide-Popup
  }
})

$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 60000
$pollTimer.add_Tick({ param($s, $e) Load-Data })

$script:KickTimer = New-Object System.Windows.Forms.Timer
$script:KickTimer.Interval = 6000
$script:KickTimer.add_Tick({ param($s, $e) $s.Stop(); Load-Data })

# Load meters BEFORE the icon is live so the first hover/click gets a full-size box
Load-Data

# If the desk is not running, start it. Nobody should have to right-click and
# pick "Start desk" to make their own meters work -- opening the app should mean
# the app is open. (Captain, 2026-07-20.)
if (-not $script:DeskUp) {
  Write-TrayLog 'desk_down_at_boot -> starting it'
  Start-Desk
}

Clear-TrayTip
$notify.Visible = $true
Write-TrayLog ('notify_visible desk=' + $script:DeskUp)
Log-Environment
try {
  $r0 = Get-IconRectRaw
  if ($null -eq $r0) {
    Write-TrayLog 'icon_rect_boot null'
  } else {
    $s0 = Get-ScreenForPoint (New-Object System.Drawing.Point(
      ($r0.Left + [int]($r0.Width / 2)), $r0.Top))
    $sn = 'none'
    if ($null -ne $s0) { $sn = 'primary=' + $s0.Primary }
    Write-TrayLog ('icon_rect_boot ' + $r0.Left + ',' + $r0.Top + ' ' +
      $r0.Width + 'x' + $r0.Height + ' screen=' + $sn)
  }
} catch {}
$hoverTimer.Start()
$pollTimer.Start()

# One balloon so Windows surfaces the icon (often hidden in the overflow).
try {
  if (-not $script:DidBalloon) {
    $script:DidBalloon = $true
    $notify.BalloonTipTitle = 'Riah Usage'
    $notify.BalloonTipText = 'Left-click the icon for meters. Right-click for the menu.'
    $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
    $notify.ShowBalloonTip(4000)
  }
} catch {
  Write-TrayLog ('balloon_fail ' + $_.Exception.Message)
}

$ctx = New-Object System.Windows.Forms.ApplicationContext
Write-TrayLog 'run_loop'
try {
  [System.Windows.Forms.Application]::Run($ctx)
} catch {
  Write-TrayLog ('run_fail ' + $_.Exception.Message)
} finally {
  Write-TrayLog 'exit'
  try { $notify.Visible = $false; $notify.Dispose() } catch {}
  try { if ($script:IconHandle -ne [IntPtr]::Zero) { [RiahTray.Native]::DestroyIcon($script:IconHandle) | Out-Null } } catch {}
  try { $mutex.ReleaseMutex() } catch {}
}
