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
#   click <x> <y> [dbl|mid]   post a mouse click to the tab bar at bar-relative pixels (does not move the real cursor)
#   shot <name>            capture tab bar + visible instance window into <dev>\shots\<name>.png
param([string]$cmd, [string]$a1, [string]$a2, [string]$a3)
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
  'bar' { (Api GET '/api/debug/tabbar').data | ConvertTo-Json -Depth 8 -Compress }
  'click' {
    $d = (Api GET '/api/debug/tabbar').data; $h = [IntPtr][long]$d.bar
    $lp = [IntPtr](([int]$a2 -shl 16) -bor ([int]$a1 -band 0xFFFF))
    [void][W]::PostMessage($h, 0x0200, [IntPtr]0, $lp)
    switch ($a3) {
      'dbl' { [void][W]::PostMessage($h, 0x0201, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp); [void][W]::PostMessage($h, 0x0203, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp) }
      'mid' { [void][W]::PostMessage($h, 0x0207, [IntPtr]0x10, $lp); [void][W]::PostMessage($h, 0x0208, [IntPtr]0, $lp) }
      'hover' { }
      default { [void][W]::PostMessage($h, 0x0201, [IntPtr]1, $lp); [void][W]::PostMessage($h, 0x0202, [IntPtr]0, $lp) }
    }
    Start-Sleep -Milliseconds 700
    (Api GET '/api/debug/tabbar').data | ConvertTo-Json -Depth 8 -Compress
  }
  'shot' {
    $d = (Api GET '/api/debug/tabbar').data
    $wins = @($d.windows | ? { $_.visible })
    $items = @()
    foreach ($w in $wins) { $items += ,@([IntPtr][long]$w.hwnd, $w.rect) }
    if ($d.shown) { $items += ,@([IntPtr][long]$d.bar, $d.rect) }
    if ($items.Count -eq 0) { 'nothing visible'; break }
    $L = ($items | % { $_[1].L } | measure -Minimum).Minimum; $T = ($items | % { $_[1].T } | measure -Minimum).Minimum
    $R = ($items | % { $_[1].R } | measure -Maximum).Maximum; $B = ($items | % { $_[1].B } | measure -Maximum).Maximum
    $bmp = New-Object System.Drawing.Bitmap ([int]($R - $L)), ([int]($B - $T)); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 255))
    foreach ($it in $items) { $b = [W]::Grab($it[0]); if ($b) { $g.DrawImage($b, [int]($it[1].L - $L), [int]($it[1].T - $T)); $b.Dispose() } }
    $g.Dispose(); $out = "$dev\shots\$a1.png"; $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    # what is really on screen at the middle of the bar (no pixels read: only which window is there)
    $top = 'n/a'; if ($d.shown) { $pt = New-Object System.Drawing.Point ([int](($d.rect.L + $d.rect.R) / 2)), ([int](($d.rect.T + $d.rect.B) / 2)); $top = if ([W]::GetAncestor([W]::WindowFromPoint($pt), 2) -eq [IntPtr][long]$d.bar) { 'bar' } else { 'OTHER WINDOW' } }
    $fg = [W]::GetForegroundWindow(); $fgIs = ($d.windows | ? { [IntPtr][long]$_.hwnd -eq $fg } | % { "instance #$($_.no)" }); if (-not $fgIs) { $fgIs = 'other' }
    "saved $out  ($($R - $L)x$($B - $T))  on-screen-at-bar=$top  foreground=$fgIs  visible-windows=$($wins.Count)/$(@($d.windows).Count)"
  }
  default { 'commands: build <branch> | start | stop | api <METHOD> <path> [json] | bar | click <x> <y> [dbl|mid|hover] | shot <name>' }
}
