param([string]$Title = 'AI 任务', [string]$StateFile = '')
# Codex-style task panel: a small always-on-top card pinned under the top
# centre, showing the task title, the current step, and a spinner-ish dot.
# Reads $StateFile (JSON: {step, done, total, current}) every 300ms and
# repaints. Exit when the file contains "stop": true or after 10 min.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Name PN -Namespace DPN -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr prm); [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f); [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v); [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h); [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);'

$ex = [uint32]0x00080000 -bor [uint32]0x00000020 -bor [uint32]0x00000080 -bor [uint32]0x08000000
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$w = 340; $h = 92
$x = [int](($wa.Width - $w) / 2); $y = $wa.Y + 8
$ov = [DPN.PN]::CreateWindowExW($ex, 'Static', 'dsbox-panel', [uint32]'0x90000000', $x, $y, $w, $h, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
if ($ov -eq [IntPtr]::Zero) { Write-Error 'panel window failed'; exit 1 }
[void][DPN.PN]::SetWindowLongW($ov, -20, [int]$ex)

$bgColor = [System.Drawing.Color]::FromArgb(235, 24, 24, 28)
$accent = [System.Drawing.Color]::FromArgb(255, 255, 170, 40)
$white = [System.Drawing.Color]::FromArgb(255, 235, 235, 240)
$muted = [System.Drawing.Color]::FromArgb(255, 150, 150, 160)

function Render([string]$step, [int]$done, [int]$total, [bool]$finished) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $bg = New-Object System.Drawing.SolidBrush($bgColor)
  $g.FillRectangle($bg, 0, 0, $w, $h)
  $ftTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
  $ftStep = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $cTitle = New-Object System.Drawing.SolidBrush($accent)
  $cWhite = New-Object System.Drawing.SolidBrush($white)
  $cMuted = New-Object System.Drawing.SolidBrush($muted)
  $g.DrawString('AI', $ftTitle, $cTitle, 12, 8)
  $g.DrawString($Title, $ftTitle, $cWhite, 34, 8)
  $progress = if ($total -gt 0) { "$done/$total" } else { '' }
  $g.DrawString($progress, $ftTitle, $cMuted, $w - 60, 8)
  $dotBrush = New-Object System.Drawing.SolidBrush($(if ($finished) { [System.Drawing.Color]::FromArgb(255, 80, 220, 120) } else { $accent }))
  $g.FillEllipse($dotBrush, 14, 40, 10, 10)
  $g.DrawString($step, $ftStep, $cWhite, 34, 36)
  $barBrush = New-Object System.Drawing.SolidBrush($accent)
  $barBg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 50, 50, 56))
  $g.FillRectangle($barBg, 12, 68, $w - 24, 5)
  $frac = if ($total -gt 0) { [Math]::Min(1.0, $done / $total) } else { 0.3 }
  $g.FillRectangle($barBrush, 12, 68, [int](($w - 24) * $frac), 5)
  $g.Dispose(); $bmp.Dispose(); $bg.Dispose(); $ftTitle.Dispose(); $ftStep.Dispose()
  $cTitle.Dispose(); $cWhite.Dispose(); $cMuted.Dispose(); $dotBrush.Dispose(); $barBrush.Dispose(); $barBg.Dispose()
  # draw the freshly rendered bitmap
  $hdc = [DPN.PN]::GetDC($ov)
  $gdc = [System.Drawing.Graphics]::FromHdc($hdc)
  $tmp = New-Object System.Drawing.Bitmap($w, $h)
  $gtmp = [System.Drawing.Graphics]::FromImage($tmp)
  $gtmp.DrawImage($bmp, 0, 0)
  $gtmp.Dispose()
  $gdc.DrawImage($tmp, 0, 0)
  $gdc.Dispose(); $tmp.Dispose()
  [void][DPN.PN]::ReleaseDC($ov, $hdc)
}

Render '准备中…' 0 0 $false
[void][DPN.PN]::SetLayeredWindowAttributes($ov, 0, 240, 0x2)

$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  if ($StateFile -and (Test-Path $StateFile)) {
    try {
      $st = Get-Content $StateFile -Raw | ConvertFrom-Json
      if ($st.stop) { break }
      Render $st.step $st.done $st.total $([bool]$st.finished)
      if ($st.finished) {
        Start-Sleep -Milliseconds 2500
        break
      }
    } catch { }
  }
  Start-Sleep -Milliseconds 300
}
[void][DPN.PN]::DestroyWindow($ov)
Write-Host 'panel closed'
