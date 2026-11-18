# 在屏幕上边 / 左边停靠一条“应用栏”（和任务栏是同一种东西：系统会把它占的地方从可用区域里扣掉），一直开着。
# CI 上核对“任务栏在上边 / 左边时铺满对不对”用（decisions UI-20）：测试机上真的任务栏挪不动，直接改可用区域又会被资源管理器改回去。
# 用法：pwsh -File appbar.ps1 top|left
$edgeName = $args[0]
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class AB {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint uCallbackMessage; public uint uEdge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] public static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
}
"@
$edge = @{ left = 0; top = 1 }[$edgeName]
if ($null -eq $edge) { throw 'top / left' }
$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.ShowInTaskbar = $false; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.BackColor = [Drawing.Color]::FromArgb(40, 44, 52); $f.Text = 'masktab-ci-appbar'
$f.Location = New-Object Drawing.Point 0, 0; $f.Size = New-Object Drawing.Size 10, 10
$f.Add_Shown({
  $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $d = New-Object AB+APPBARDATA
  $d.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][AB+APPBARDATA]); $d.hWnd = $f.Handle; $d.uCallbackMessage = 0x8001
  [void][AB]::SHAppBarMessage(0, [ref]$d)   # ABM_NEW
  $d.uEdge = $edge
  $d.rc.L = $b.Left; $d.rc.T = $b.Top; $d.rc.R = $b.Right; $d.rc.B = $b.Bottom
  if ($edge -eq 1) { $d.rc.B = $b.Top + 48 } else { $d.rc.R = $b.Left + 62 }
  [void][AB]::SHAppBarMessage(2, [ref]$d)   # ABM_QUERYPOS：系统按别的栏调整
  if ($edge -eq 1) { $d.rc.B = $d.rc.T + 48 } else { $d.rc.R = $d.rc.L + 62 }
  [void][AB]::SHAppBarMessage(3, [ref]$d)   # ABM_SETPOS
  [void][AB]::MoveWindow($f.Handle, $d.rc.L, $d.rc.T, $d.rc.R - $d.rc.L, $d.rc.B - $d.rc.T, $true)
})
[Windows.Forms.Application]::Run($f)
