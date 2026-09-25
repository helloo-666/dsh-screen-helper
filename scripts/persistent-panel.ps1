param([string]$Title = 'AI 任务', [string]$StateFile = '')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI'
$form.Size = New-Object System.Drawing.Size(380, 130)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(770, 8)
$form.TopMost = $true
$form.FormBorderStyle = 'None'
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 28)
$form.ShowInTaskbar = $false

$lblAI = New-Object System.Windows.Forms.Label
$lblAI.Text = 'AI'
$lblAI.ForeColor = [System.Drawing.Color]::FromArgb(255, 255, 170, 40)
$lblAI.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$lblAI.Location = New-Object System.Drawing.Point(18, 10)
$lblAI.AutoSize = $true
$form.Controls.Add($lblAI)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $Title
$lblTitle.ForeColor = [System.Drawing.Color]::White
$lblTitle.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$lblTitle.Location = New-Object System.Drawing.Point(46, 11)
$lblTitle.AutoSize = $true
$form.Controls.Add($lblTitle)

$lblStep = New-Object System.Windows.Forms.Label
$lblStep.Text = '待机中'
$lblStep.ForeColor = [System.Drawing.Color]::FromArgb(255, 200, 200, 210)
$lblStep.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$lblStep.Location = New-Object System.Drawing.Point(18, 48)
$lblStep.AutoSize = $true
$form.Controls.Add($lblStep)

# 自绘平滑进度条：渐变蓝→青，带流动动画
$script:progressPanel = New-Object System.Windows.Forms.Panel
$script:progressPanel.Location = New-Object System.Drawing.Point(18, 92)
$script:progressPanel.Size = New-Object System.Drawing.Size(344, 6)
$script:progressTarget = 0.0   # 目标进度 0-1
$script:progressCurrent = 0.0  # 当前显示进度
$script:phase = 0.0            # 流动动画相位
$script:progressPanel.Add_Paint({
  param($p, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear($p.Parent.BackColor)
  # 背景轨道
  $trackBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 50, 50, 56))
  $trackPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $trackPath.AddArc(0, 0, 6, 6, 180, 90)
  $trackPath.AddArc($p.Width - 6, 0, 6, 6, 270, 90)
  $trackPath.AddArc($p.Width - 6, $p.Height - 6, 6, 6, 0, 90)
  $trackPath.AddArc(0, $p.Height - 6, 6, 6, 90, 90)
  $trackPath.CloseFigure()
  $g.FillPath($trackBrush, $trackPath)
  # 进度填充（渐变蓝→青）
  $fillW = [int]([Math]::Max(0.0, [Math]::Min(1.0, $script:progressCurrent)) * $p.Width)
  if ($fillW -gt 6) {
    $fillPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fillPath.AddArc(0, 0, 6, 6, 180, 90)
    $fillPath.AddArc($fillW - 6, 0, 6, 6, 270, 90)
    $fillPath.AddArc($fillW - 6, $p.Height - 6, 6, 6, 0, 90)
    $fillPath.AddArc(0, $p.Height - 6, 6, 6, 90, 90)
    $fillPath.CloseFigure()
    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      (New-Object System.Drawing.Point(0, 0)),
      (New-Object System.Drawing.Point($p.Width, 0)),
      [System.Drawing.Color]::FromArgb(255, 0, 120, 255),
      [System.Drawing.Color]::FromArgb(255, 0, 220, 255))
    $g.FillPath($grad, $fillPath)
    $grad.Dispose(); $fillPath.Dispose(); $trackBrush.Dispose(); $trackPath.Dispose()
  }
  $e.Graphics.Dispose | Out-Null
})
$form.Controls.Add($script:progressPanel)

$form.Show()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  try {
    if (Test-Path $StateFile) {
      $raw = [System.IO.File]::ReadAllText($StateFile)
      if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
      $st = $raw | ConvertFrom-Json
      $lblStep.Text = $st.step
      $script:progressTarget = [Math]::Min(1.0, $st.done / [Math]::Max(1, $st.total))
      if ($st.finished) {
        $end = [System.Diagnostics.Stopwatch]::StartNew()
        while ($end.ElapsedMilliseconds -lt 2500) {
          [System.Windows.Forms.Application]::DoEvents()
          Start-Sleep -Milliseconds 50
        }
        $form.Close()
      }
    }
  } catch { }
  [System.Windows.Forms.Application]::DoEvents()
})
$timer.Start()

# 30 分钟硬超时
$hardTimeout = [System.Diagnostics.Stopwatch]::StartNew()
# 平滑插值循环：progressCurrent 每帧向 progressTarget 缓动（10%/帧 → 约 250ms 到位），同时流动光带
while ($hardTimeout.ElapsedMilliseconds -lt 1800000) {
  [System.Windows.Forms.Application]::DoEvents()
  $diff = $script:progressTarget - $script:progressCurrent
  if ([Math]::Abs($diff) -gt 0.001) {
    $script:progressCurrent += $diff * 0.15
    $script:progressPanel.Invalidate()
  }
  $script:phase = ($script:phase + 0.03) % 1.0
  Start-Sleep -Milliseconds 40
  if ($form.IsDisposed) { break }
}