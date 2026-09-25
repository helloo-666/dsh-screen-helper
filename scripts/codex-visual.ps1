Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
if (-not ('dsboxEsc' -as [type])) {
  Add-Type -Name dsboxEsc -Namespace dsboxNative -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);'
}

# ---------- 蓝色横幅条（顶部全宽，WinForms 实现） ----------
function Show-Banner([string]$Text, [int]$Ms = 2000) {
  $form = $null
  try {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'dsbox-banner'
    $form.FormBorderStyle = 'None'
    $form.StartPosition = 'Manual'
    $form.Location = New-Object System.Drawing.Point($wa.X, $wa.Y)
    $form.Size = New-Object System.Drawing.Size($wa.Width, 36)
    $form.BackColor = [System.Drawing.Color]::FromArgb(240, 0, 103, 192)
    $form.TopMost = $true
    $form.ShowInTaskbar = $false

    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $Text
    $lbl.ForeColor = [System.Drawing.Color]::White
    $lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
    $lbl.AutoSize = $false
    $lbl.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $lbl.Dock = [System.Windows.Forms.DockStyle]::Fill
    $form.Controls.Add($lbl)

    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()

    # Esc 取消：轮询期间给用户机会中止
    $cancelled = $false
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $Ms) {
      if ([dsboxNative.dsboxEsc]::GetAsyncKeyState(0x1B) -ne 0) { $cancelled = $true; break }
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 40
    }
    # 淡出
    for ($o = 100; $o -ge 0; $o -= 20) {
      $form.Opacity = $o / 100.0
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 50
    }
    return $cancelled
  } catch { return $false }
  finally { if ($form) { $form.Close(); $form.Dispose() } }
}

# ---------- AI 光标（黑色箭头 + 蓝色光晕 + 涟漪，WinForms 实现） ----------
function Show-CodexCursor([int]$ToX, [int]$ToY, [int]$FromX = -1, [int]$FromY = -1, [int]$Ms = 900) {
  $form = $null
  try {
    $startX = if ($FromX -ge 0) { $FromX } else { $ToX }
    $startY = if ($FromY -ge 0) { $FromY } else { $ToY }
    $size = 120
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
      $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
      $gp.AddEllipse(4, 4, $size - 8, $size - 8)
      $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
      $pgb.CenterColor = [System.Drawing.Color]::FromArgb(130, 0, 140, 255)
      $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 140, 255))
      $g.FillEllipse($pgb, 4, 4, $size - 8, $size - 8)
      $pgb.Dispose(); $gp.Dispose()
      if ($script:ripple -gt 0) {
        $rc = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 0, 140, 255), 3)
        $rad = 12 + $script:ripple * 12
        $g.DrawEllipse($rc, ($size/2) - $rad, ($size/2) - $rad, $rad * 2, $rad * 2)
        $rc.Dispose()
      }
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
      $form.Location = New-Object System.Drawing.Point($px - ($size/2), $py - ($size/2))
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 18
    }
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
  } catch { }
  finally { if ($form) { $form.Close(); $form.Dispose() } }
}
