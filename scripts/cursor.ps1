param(
  [int]$ToX = 100,
  [int]$ToY = 100,
  [int]$FromX = -1,
  [int]$FromY = -1,
  [int]$Ms = 900
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$size = 120
$startX = if ($FromX -ge 0) { $FromX } else { $ToX }
$startY = if ($FromY -ge 0) { $FromY } else { $ToY }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsbox-cursor'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Size = New-Object System.Drawing.Size($size, $size)
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Opacity = 0.95

$script:ripple = 0
$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  # 蓝色光晕
  $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gp.AddEllipse(4, 4, $size - 8, $size - 8)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(130, 0, 140, 255)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 140, 255))
  $g.FillEllipse($pgb, 4, 4, $size - 8, $size - 8)
  $pgb.Dispose(); $gp.Dispose()
  # 点击涟漪
  if ($script:ripple -gt 0) {
    $rc = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 0, 140, 255), 3)
    $rad = 12 + $script:ripple * 12
    $g.DrawEllipse($rc, ($size / 2) - $rad, ($size / 2) - $rad, $rad * 2, $rad * 2)
    $rc.Dispose()
  }
  # 黑色标准箭头
  $pts = @(
    (New-Object System.Drawing.Point(48, 32)), (New-Object System.Drawing.Point(48, 76)),
    (New-Object System.Drawing.Point(62, 62)), (New-Object System.Drawing.Point(74, 84)),
    (New-Object System.Drawing.Point(82, 80)), (New-Object System.Drawing.Point(70, 58)),
    (New-Object System.Drawing.Point(88, 58))
  )
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 12, 12, 12))
  $penW = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2.5)
  $g.FillPolygon($fill, $pts)
  $g.DrawPolygon($penW, $pts)
  $fill.Dispose(); $penW.Dispose()
})

$form.Show()
$frames = 16
$dx = $ToX - $startX; $dy = $ToY - $startY
for ($f = 1; $f -le $frames; $f++) {
  $t = $f / $frames
  $ease = 1 - [Math]::Pow(1 - $t, 3)
  $px = [int]($startX + $dx * $ease)
  $py = [int]($startY + $dy * $ease)
  $form.Location = New-Object System.Drawing.Point($px - ($size / 2), $py - ($size / 2))
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 18
}
# 涟漪
for ($r = 1; $r -le 4; $r++) {
  $script:ripple = $r
  $form.Invalidate()
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 55
}
$script:ripple = 0
$form.Invalidate()
Start-Sleep -Milliseconds ([Math]::Max(150, $Ms - 500))
for ($o = 95; $o -ge 0; $o -= 24) {
  $form.Opacity = $o / 100.0
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 50
}
$form.Close()
