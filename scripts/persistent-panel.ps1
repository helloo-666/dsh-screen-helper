param([string]$Title = 'AI 任务', [string]$StateFile = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---- 设计令牌：深色现代风（与 DSH 深色界面搭配）----
$clrTop    = [System.Drawing.Color]::FromArgb(32, 34, 42)
$clrBottom = [System.Drawing.Color]::FromArgb(24, 26, 32)
$clrText   = [System.Drawing.Color]::FromArgb(245, 246, 250)
$clrMuted  = [System.Drawing.Color]::FromArgb(158, 163, 178)
$clrAccent = [System.Drawing.Color]::FromArgb(88, 150, 255)
$clrAccent2= [System.Drawing.Color]::FromArgb(72, 214, 200)
$clrOrange = [System.Drawing.Color]::FromArgb(255, 138, 48)
$clrOrange2= [System.Drawing.Color]::FromArgb(255, 92, 32)
$fUI       = 'Microsoft YaHei UI'

$W = 420; $H = 104; $rad = 20
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI'
$form.Size = New-Object System.Drawing.Size($W, $H)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(750, 12)
$form.TopMost = $true
$form.FormBorderStyle = 'None'
$form.BackColor = $clrBottom
$form.ShowInTaskbar = $false

# 圆角区域
$region = New-Object System.Drawing.Drawing2D.GraphicsPath
$region.AddArc(0, 0, $rad * 2, $rad * 2, 180, 90)
$region.AddArc($W - $rad * 2, 0, $rad * 2, $rad * 2, 270, 90)
$region.AddArc($W - $rad * 2, $H - $rad * 2, $rad * 2, $rad * 2, 0, 90)
$region.AddArc(0, $H - $rad * 2, $rad * 2, $rad * 2, 90, 90)
$region.CloseFigure()
$form.Region = New-Object System.Drawing.Region($region)

$script:progCur = 0.0
$script:progTarget = 0.0
$script:stepText = '准备中…'
$script:pulse = 0.0

$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  # 卡片背景：垂直微渐变
  $bgGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point(0, $H)),
    $clrTop, $clrBottom)
  $g.FillPath($bgGrad, $region)
  $bgGrad.Dispose()

  # 微光内描边
  $edge = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(34, 255, 255, 255), 1)
  $g.DrawPath($edge, $region)
  $edge.Dispose()

  # 徽章胶囊（橙色渐变 + AI）
  $bx = 18; $by = 17; $bw = 34; $bh = 20; $br = 9
  $badge = New-Object System.Drawing.Drawing2D.GraphicsPath
  $badge.AddArc($bx, $by, $br * 2, $br * 2, 90, 180)
  $badge.AddArc($bx + $bw - $br * 2, $by, $br * 2, $br * 2, 270, 180)
  $badge.CloseFigure()
  $bGrad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point($bx, $by)),
    (New-Object System.Drawing.Point($bx + $bw, $by + $bh)),
    $clrOrange, $clrOrange2)
  $g.FillPath($bGrad, $badge)
  $bGrad.Dispose(); $badge.Dispose()
  $fBadge = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
  $wBadge = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $szB = $g.MeasureString('AI', $fBadge)
  $g.DrawString('AI', $fBadge, $wBadge, $bx + ($bw - $szB.Width) / 2, $by + ($bh - $szB.Height) / 2 + 1)
  $fBadge.Dispose(); $wBadge.Dispose()

  # 标题（徽章右侧）
  $fTitle = New-Object System.Drawing.Font($fUI, 11, [System.Drawing.FontStyle]::Bold)
  $tBrush = New-Object System.Drawing.SolidBrush($clrText)
  $g.DrawString($Title, $fTitle, $tBrush, 62, 19)
  $tBrush.Dispose(); $fTitle.Dispose()

  # 步骤行（带脉冲圆点）
  $pulseR = 3.5 + [Math]::Sin($script:pulse) * 0.8
  $dotBrush = New-Object System.Drawing.SolidBrush($clrAccent)
  $g.FillEllipse($dotBrush, 20, 50, $pulseR * 2, $pulseR * 2)
  $dotBrush.Dispose()
  $fStep = New-Object System.Drawing.Font($fUI, 10)
  $sBrush = New-Object System.Drawing.SolidBrush($clrMuted)
  $g.DrawString($script:stepText, $fStep, $sBrush, 34, 46)
  $sBrush.Dispose(); $fStep.Dispose()

  # 进度条（细、圆角、渐变、端点光晕）
  $px = 20; $py = 82; $pw = $W - 40; $ph = 5
  $track = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 46, 49, 58))
  $tPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tPath.AddArc($px, $py, $ph, $ph, 90, 180)
  $tPath.AddArc($px + $pw - $ph, $py, $ph, $ph, 270, 180)
  $tPath.CloseFigure()
  $g.FillPath($track, $tPath); $track.Dispose(); $tPath.Dispose()

  $fw = [int]([Math]::Max(0.0, [Math]::Min(1.0, $script:progCur)) * $pw)
  if ($fw -gt 4) {
    $fPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fPath.AddArc($px, $py, $ph, $ph, 90, 180)
    $fPath.AddArc($px + $fw - $ph, $py, $ph, $ph, 270, 180)
    $fPath.CloseFigure()
    $fg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point($px, $py)),
      (New-Object System.Drawing.Point($px + $pw, $py)),
      $clrAccent, $clrAccent2)
    $g.FillPath($fg, $fPath)
    $fg.Dispose(); $fPath.Dispose()
    $glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 88, 150, 255))
    $g.FillEllipse($glow, $px + $fw - 6, $py - 3, 11, 11)
    $glow.Dispose()
  }
})

$form.Show()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 90
$timer.Add_Tick({
  try {
    if (Test-Path $StateFile) {
      $raw = [System.IO.File]::ReadAllText($StateFile)
      if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
      $st = $raw | ConvertFrom-Json
      if ($st.step) { $script:stepText = $st.step }
      $script:progTarget = [Math]::Min(1.0, $st.done / [Math]::Max(1, $st.total))
      if ($st.finished) {
        $t0 = [System.Diagnostics.Stopwatch]::StartNew()
        while ($t0.ElapsedMilliseconds -lt 2600) {
          [System.Windows.Forms.Application]::DoEvents()
          Start-Sleep -Milliseconds 50
        }
        $form.Close()
      }
    }
  } catch { }
  $d = $script:progTarget - $script:progCur
  if ([Math]::Abs($d) -gt 0.001) { $script:progCur += $d * 0.14 }
  $script:pulse += 0.22
  $form.Invalidate()
})
$timer.Start()

$hard = [System.Diagnostics.Stopwatch]::StartNew()
while ($hard.ElapsedMilliseconds -lt 1800000) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 40
  if ($form.IsDisposed) { break }
}