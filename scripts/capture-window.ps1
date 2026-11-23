# Captures one window by process name using PrintWindow(PW_RENDERFULLCONTENT).
#
# CopyFromScreen grabs whatever is on top, which is useless for an unattended
# capture on a busy desktop. PrintWindow asks the window to paint itself, so the
# result does not depend on focus or z-order.
#
# Usage: powershell -File scripts/capture-window.ps1 [-ProcessName zenith] [-Out ui-capture.png]
param(
  [string]$ProcessName = "zenith",
  [string]$Out = "ui-capture.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
"@

$p = Get-Process -Name $ProcessName -ErrorAction Stop |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if (-not $p) {
  throw "no visible window for process '$ProcessName'"
}

$h = $p.MainWindowHandle
$r = New-Object -TypeName 'Win+RECT'
[Win]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$hh = $r.Bottom - $r.Top
if ($w -le 0 -or $hh -le 0) {
  throw "window '$($p.MainWindowTitle)' has no client area (${w}x${hh})"
}

$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT: required for DirectComposition surfaces such as
# WebView2, which otherwise print an empty frame.
$ok = [Win]::PrintWindow($h, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()

if (-not $ok) {
  $bmp.Dispose()
  throw "PrintWindow failed for '$($p.MainWindowTitle)'"
}

$path = Join-Path $PWD $Out
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $path ${w}x${hh} title='$($p.MainWindowTitle)'"
