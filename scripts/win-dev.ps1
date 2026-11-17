# Real-machine test helper for Windows (see docs/decisions.md UI-15, "real machine testing").
# ASCII only on purpose: Windows PowerShell 5.1 reads a .ps1 without BOM in the local code page, Chinese text would break it.
#
# Layout (everything inside one folder, nothing else on the machine is touched):
#   <dev>\src         source of the branch            <dev>\go        portable Go
#   <dev>\masktab.exe dev build                       <dev>\data      test data (NOT the user's real data)
#   <dev>\shots       screenshots of the test windows only (PrintWindow: never captures other windows)
#
# Usage:  powershell -File win-dev.ps1 <command> [args]
#   build <branch>         fetch + checkout + go build (stops the dev instance first)
#   start | stop           start / stop the dev core service (separate data dir, never the installed one)
#   api <METHOD> <path> [json]
#   bar                    print the tab bar state (GET /api/debug/tabbar)
#   log [n]                last n lines of the dev core log
#   click <x> <y> [dbl|mid]   post a mouse click to the tab bar at bar-relative pixels (does not move the real cursor)
#   drag <group> <bx> <by> <sx> <sy> [hold]   press at bar-relative (bx,by) of that group's bar, move to SCREEN point (sx,sy), release
#                          (posted messages carrying the test flag 0x8000, see mkTest in bar_windows.go; the real cursor does not move)
#   shot <name>            capture every tab bar + visible instance window into <dev>\shots\<name>.png (PrintWindow, no borders/shadows)
#   snap <name>            real screen pixels of the current group's bar + window (6 px margin), ONLY if nothing else covers it
param([string]$cmd, [string]$a1, [string]$a2, [string]$a3, [string]$a4, [string]$a5, [string]$a6)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$dev = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
$exe = "$dev\masktab.exe"; $data = "$dev\data"; $lock = "$data\state\running.lock"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Drawing; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  public static Bitmap Grab(IntPtr h) {
    RECT r; GetWindowRect(h, out r); int w = r.R - r.L, hh = r.B - r.T; if (w <= 0 || hh <= 0) return null;
    Bitmap b = new Bitmap(w, hh); using (Graphics g = Graphics.FromImage(b)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); } return b;
  }
}
"@
[void][W]::SetProcessDpiAwarenessContext([IntPtr](-4))

function Api($method, $path, $body) {
  $l = (Get-Content $lock -Raw).Trim() -split '\s+'
  $p = @{ Method = $method; Uri = "http://127.0.0.1:$($l[0])$path"; Headers = @{ 'X-MaskTab-Token' = $l[1] }; TimeoutSec = 60 }
  if ($body) { $p.Body = [System.Text.Encoding]::UTF8.GetBytes($body); $p.ContentType = 'application/json' }
  Invoke-RestMethod @p
}
function Running { if (-not (Test-Path $lock)) { return $false }; try { [void](Api GET '/api/debug/tabbar'); return $true } catch { return $false } }
function Stop-Dev {
  if (Running) { & $exe -data $data -quit | Out-Null }
  # only processes started from the dev folder; the installed MaskTab has a different path
  Get-Process masktab -ErrorAction SilentlyContinue | ? { $_.Path -eq $exe } | % { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $lock -ErrorAction SilentlyContinue
}

switch ($cmd) {
  'build' {
    Stop-Dev
    $env:GOCACHE = "$dev\gocache"; $env:GOMODCACHE = "$dev\gomod"; $env:GOFLAGS = '-buildvcs=false'; $env:GOPROXY = 'https://goproxy.cn,https://proxy.golang.org,direct'
    # Source comes as a tarball from api.github.com: plain "git fetch" from github.com is unreliable on some networks.
    $tgz = "$dev\src.tgz"; $ok = $false
    for ($i = 0; $i -lt 4 -and -not $ok; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 40 "https://api.github.com/repos/halou367/masktab/tarball/$a1" -OutFile $tgz; $ok = $true } catch { Start-Sleep 2 } }
    if (-not $ok) { 'DOWNLOAD FAILED'; exit 1 }
    Remove-Item "$dev\src.new", "$dev\src.old" -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory "$dev\src.new" | Out-Null
    & tar -xzf $tgz -C "$dev\src.new" --strip-components=1; if ($LASTEXITCODE -ne 0) { 'UNPACK FAILED'; exit 1 }
    Set-Location $dev
    if (Test-Path "$dev\src") { Rename-Item "$dev\src" 'src.old' }; Rename-Item "$dev\src.new" 'src'; Remove-Item "$dev\src.old" -Recurse -Force -ErrorAction SilentlyContinue
    Set-Location "$dev\src"
    $ErrorActionPreference = 'Continue'
    "source: $a1 " + ((& tar -tzf $tgz 2>$null | select -First 1) -replace '.*-([0-9a-f]{7})[0-9a-f]*/$', '$1'); Remove-Item $tgz
    $out = (& "$dev\go\bin\go.exe" build -ldflags "-H=windowsgui -X main.version=0.1.0-dev" -o $exe ./cmd/masktab 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { "BUILD FAILED`n$out"; exit 1 }
    "built: " + (Get-Item $exe).Length + " bytes"
  }
  'start' {
    if (Running) { 'already running'; break }
    New-Item -ItemType Directory -Force "$data\config", "$dev\shots" | Out-Null
    if (-not (Test-Path "$data\config\settings.json")) {
      # use the browser kernel of the installed MaskTab read-only (no 160 MB download); everything else is separate
      $k = (Get-ChildItem "$env:LOCALAPPDATA\Programs\MaskTab\kernel" -Recurse -Filter chrome.exe | select -First 1).FullName
      (@{ kernelPath = $k; mergeWindows = $true; updateOff = $true; restoreOnStart = $false } | ConvertTo-Json) | Set-Content -Encoding ASCII "$data\config\settings.json"
    }
    Start-Process -FilePath $exe -ArgumentList '-data', "`"$data`"", '-keep', '-no-open' -WorkingDirectory $dev
    for ($i = 0; $i -lt 60 -and -not (Running); $i++) { Start-Sleep -Milliseconds 500 }
    if (Running) { 'started' } else { 'START FAILED'; exit 1 }
  }
  'stop' { Stop-Dev; 'stopped' }
  'api' { Api $a1 $a2 $a3 | ConvertTo-Json -Depth 12 -Compress }
  'log' {
    $fs = [System.IO.File]::Open("$data\state\masktab.log", 'Open', 'Read', 'ReadWrite'); $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $n = 15; if ($a1) { $n = [int]$a1 }; $sr.ReadToEnd().Split("`n") | ? { $_.Trim() } | select -Last $n; $sr.Close()
  }
  'bar' { (Api GET '/api/debug/tabbar') | ConvertTo-Json -Depth 8 -Compress }
  'click' {
    $d = (Api GET '/api/debug/tabbar'); $h = [IntPtr][long]$d.bar
    $lp = [IntPtr](([int]$a2 -shl 16) -bor ([int]$a1 -band 0xFFFF))
    [void][W]::PostMessage($h, 0x0200, [IntPtr]0, $lp)
    switch ($a3) {
      'dbl' { [void][W]::PostMessage($h, 0x0201, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp); [void][W]::PostMessage($h, 0x0203, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp) }
      'mid' { [void][W]::PostMessage($h, 0x0207, [IntPtr]0x10, $lp); [void][W]::PostMessage($h, 0x0208, [IntPtr]0, $lp) }
      'hover' { }
      default { [void][W]::PostMessage($h, 0x0201, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp) }
    }
    Start-Sleep -Milliseconds 700
    (Api GET '/api/debug/tabbar') | ConvertTo-Json -Depth 8 -Compress
  }
  'drag' {
    $d = (Api GET '/api/debug/tabbar'); $g = $d.groups[[int]$a1]; $h = [IntPtr][long]$g.bar
    $x0 = [int]$g.rect.L + [int]$a2; $y0 = [int]$g.rect.T + [int]$a3; $x1 = [int]$a4; $y1 = [int]$a5
    function LP($x, $y) { [IntPtr]((($y -band 0xFFFF) -shl 16) -bor ($x -band 0xFFFF)) }
    [void][W]::PostMessage($h, 0x0201, [IntPtr]0x8001, (LP $x0 $y0)); Start-Sleep -Milliseconds 120
    for ($i = 1; $i -le 12; $i++) { $x = [int]($x0 + ($x1 - $x0) * $i / 12); $y = [int]($y0 + ($y1 - $y0) * $i / 12); [void][W]::PostMessage($h, 0x0200, [IntPtr]0x8001, (LP $x $y)); Start-Sleep -Milliseconds 40 }
    if ($a6 -ne 'hold') { [void][W]::PostMessage($h, 0x0202, [IntPtr]0x8000, (LP $x1 $y1)) }
    Start-Sleep -Milliseconds 900
    (Api GET '/api/debug/tabbar') | ConvertTo-Json -Depth 8 -Compress
  }
  'shot' {
    $d = (Api GET '/api/debug/tabbar')
    $wins = @($d.windows | ? { $_.visible })
    $items = @()
    foreach ($w in $wins) { $items += ,@([IntPtr][long]$w.hwnd, $w.rect) }
    foreach ($g in @($d.groups)) { if ($g.shown) { $items += ,@([IntPtr][long]$g.bar, $g.rect) } }
    if ($items.Count -eq 0) { 'nothing visible'; break }
    # careful: PowerShell variable names are case-insensitive ($b and $B are the same variable)
    $L = ($items | % { $_[1].L } | measure -Minimum).Minimum; $T = ($items | % { $_[1].T } | measure -Minimum).Minimum
    $R = ($items | % { $_[1].R } | measure -Maximum).Maximum; $B = ($items | % { $_[1].B } | measure -Maximum).Maximum
    $bmp = New-Object System.Drawing.Bitmap ([int]($R - $L)), ([int]($B - $T)); $g2 = [System.Drawing.Graphics]::FromImage($bmp); $g2.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 255))
    foreach ($it in $items) { $img = [W]::Grab($it[0]); if ($img) { $g2.DrawImage($img, [int]($it[1].L - $L), [int]($it[1].T - $T)); $img.Dispose() } }
    $g2.Dispose(); $out = "$dev\shots\$a1.png"; $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    $fg = [W]::GetForegroundWindow(); $fgIs = ($d.windows | ? { [IntPtr][long]$_.hwnd -eq $fg } | % { "instance #$($_.no)" }); if (-not $fgIs) { $fgIs = 'other' }
    "saved $out  ($($R - $L)x$($B - $T))  origin=$L,$T  foreground=$fgIs  groups=$(@($d.groups).Count)  visible-windows=$($wins.Count)/$(@($d.windows).Count)"
  }
  'snap' {
    $d = (Api GET '/api/debug/tabbar'); $w = $d.windows | ? { $_.id -eq $d.active }
    if (-not $w -or -not $d.shown) { 'no current group'; break }
    $bar = [IntPtr][long]$d.bar; $win = [IntPtr][long]$w.hwnd
    $L = [int]$w.vis.L; $T = [int]$d.rect.T; $R = [int]$w.vis.R; $B = [Math]::Min([int]$w.vis.B, $T + 420)
    # refuse unless the test window really is what is on screen there (no pixels are read for this check)
    $bad = 0; foreach ($fx in 0.02, 0.5, 0.98) { foreach ($yy in ($T + 10), ($T + 60), ($B - 10)) { $pt = New-Object System.Drawing.Point ([int]($L + ($R - $L) * $fx)), $yy; $r = [W]::GetAncestor([W]::WindowFromPoint($pt), 2); if ($r -ne $bar -and $r -ne $win) { $bad++ } } }
    if ($bad -gt 0) { "covered by another window at $bad of 9 points: not captured"; break }
    $m = 6; $bmp = New-Object System.Drawing.Bitmap ($R - $L + 2 * $m), ($B - $T + $m); $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen(($L - $m), ($T - $m), 0, 0, $bmp.Size); $g2.Dispose(); $out = "$dev\shots\$a1.png"; $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    "saved $out  ($($R - $L + 2 * $m)x$($B - $T + $m))  bar=$($d.rect.L),$($d.rect.T)-$($d.rect.R),$($d.rect.B)  vis=$L,$($w.vis.T)-$R,$($w.vis.B)"
  }
  default { 'commands: build <sha> | start | stop | api <METHOD> <path> [json] | bar | log [n] | click <x> <y> [dbl|mid|hover] | drag <group> <bx> <by> <sx> <sy> [hold] | shot <name> | snap <name>' }
}
