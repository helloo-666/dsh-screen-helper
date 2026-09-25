Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Name VN -Namespace DVN -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr prm); [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f); [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v); [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h); [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc); [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);'

# ---------- 蓝色横幅条（顶部全宽） ----------
function Show-Banner([string]$Text, [int]$Ms = 2000) {
  $ov = [IntPtr]::Zero
  try {
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $w = $wa.Width; $h = 36
    $x = $wa.X; $y = $wa.Y
    $ex = [uint32]0x00080000 -bor [uint32]0x00000020 -bor [uint32]0x00000080 -bor [uint32]0x08000000
    $ov = [DVN.VN]::CreateWindowExW($ex, 'Static', 'dsbox-banner', [uint32]'0x90000000', $x, $y, $w, $h, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
    if ($ov -eq [IntPtr]::Zero) { return }
    [void][DVN.VN]::SetWindowLongW($ov, -20, [int]$ex)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(240, 0, 103, 192))
    $ft = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
    $ft2 = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $cW = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $cA = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(200, 255, 255, 255))
    $g.FillRectangle($bg, 0, 0, $w, $h)
    $ts = $g.MeasureString($Text, $ft)
    $totalW = $ts.Width + 180
    $g.DrawString($Text, $ft, $cW, ([int](($w - $totalW)/2)), 6)
    $g.DrawString('Esc 取消', $ft2, $cA, ([int](($w - $totalW)/2 + $ts.Width + 20)), 8)
    $g.Dispose()
    $hdc = [DVN.VN]::GetDC($ov); $gdc = [System.Drawing.Graphics]::FromHdc($hdc); $gdc.DrawImage($bmp, 0, 0); $gdc.Dispose()
    [void][DVN.VN]::ReleaseDC($ov, $hdc); $bmp.Dispose()
    [void][DVN.VN]::SetLayeredWindowAttributes($ov, 0, 250, 0x2)
    Start-Sleep -Milliseconds $Ms
    for ($s = 3; $s -ge 1; $s--) {
      $a = [byte][Math]::Max(20, [int](250 * $s / 3))
      [void][DVN.VN]::SetLayeredWindowAttributes($ov, 0, $a, 0x2)
      Start-Sleep -Milliseconds 60
    }
  } catch { }
  finally {
    if ($ov -ne [IntPtr]::Zero) { [void][DVN.VN]::DestroyWindow($ov) }
  }
}

# ---------- 黑色箭头 + 蓝色光晕光标 ----------
function Show-CodexCursor([int]$ToX, [int]$ToY, [int]$FromX = -1, [int]$FromY = -1, [int]$Ms = 900) {
  $ov = [IntPtr]::Zero
  try {
    $glow = 56
    $w = $glow * 2; $h = $glow * 2
    $ex = [uint32]0x00080000 -bor [uint32]0x00000020 -bor [uint32]0x00000080 -bor [uint32]0x08000000
    $startX = if ($FromX -ge 0) { $FromX } else { $ToX }
    $startY = if ($FromY -ge 0) { $FromY } else { $ToY }
    $ov = [DVN.VN]::CreateWindowExW($ex, 'Static', 'dsbox-codexcursor', [uint32]'0x90000000', $startX - $glow, $startY - $glow, $w, $h, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
    if ($ov -eq [IntPtr]::Zero) { return }
    [void][DVN.VN]::SetWindowLongW($ov, -20, [int]$ex)
    # 蓝色光晕背景（径向渐变）
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gp = New-Object System.Drawing.Drawing2D.GraphicsPath
    $gp.AddEllipse(0, 0, $w, $h)
    $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($gp)
    $pgb.CenterColor = [System.Drawing.Color]::FromArgb(120, 0, 140, 255)
    $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 140, 255))
    $g.FillEllipse($pgb, 0, 0, $w, $h)
    # 黑色标准箭头（居中）
    $pts = @(
      (New-Object System.Drawing.Point(44, 30)), (New-Object System.Drawing.Point(44, 74)),
      (New-Object System.Drawing.Point(58, 60)), (New-Object System.Drawing.Point(70, 82)),
      (New-Object System.Drawing.Point(78, 78)), (New-Object System.Drawing.Point(66, 56)),
      (New-Object System.Drawing.Point(84, 56))
    )
    $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 10, 10, 10))
    $penW = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 2.5)
    $g.FillPolygon($fill, $pts)
    $g.DrawPolygon($penW, $pts)
    $g.Dispose()
    $hdc = [DVN.VN]::GetDC($ov); $gdc = [System.Drawing.Graphics]::FromHdc($hdc); $gdc.DrawImage($bmp, 0, 0); $gdc.Dispose()
    [void][DVN.VN]::ReleaseDC($ov, $hdc); $bmp.Dispose()
    [void][DVN.VN]::SetLayeredWindowAttributes($ov, 0, 235, 0x2)
    # 滑动动画
    $frames = 16
    $dx = $ToX - $startX; $dy = $ToY - $startY
    for ($f = 1; $f -le $frames; $f++) {
      $t = $f / $frames
      $ease = 1 - [Math]::Pow(1 - $t, 3)
      $px = [int]($startX + $dx * $ease)
      $py = [int]($startY + $dy * $ease)
      [void][DVN.VN]::SetWindowPos($ov, [IntPtr](-1), $px - $glow, $py - $glow, 0, 0, 0x0015)
      Start-Sleep -Milliseconds 18
    }
    # 点击涟漪（蓝色圆圈扩散）
    $bmp2 = New-Object System.Drawing.Bitmap(120, 120)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $rc = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 0, 140, 255), 3)
    for ($rs = 1; $rs -le 5; $rs++) {
      $g2.Clear([System.Drawing.Color]::Transparent)
      $rad = 10 + $rs * 12
      $g2.DrawEllipse($rc, 60 - $rad, 60 - $rad, $rad * 2, $rad * 2)
      $hdc3 = [DVN.VN]::GetDC($ov)
      $g3 = [System.Drawing.Graphics]::FromHdc($hdc3)
      $g3.DrawImage($bmp2, $ToX - $glow - 60 + $glow, $ToY - $glow - 60 + $glow)
      $g3.Dispose()
      [void][DVN.VN]::ReleaseDC($ov, $hdc3)
      Start-Sleep -Milliseconds 40
    }
    $rc.Dispose(); $bmp2.Dispose()
    Start-Sleep -Milliseconds ([Math]::Max(200, $Ms - 500))
    for ($s = 4; $s -ge 1; $s--) {
      $a = [byte][Math]::Max(15, [int](235 * $s / 4))
      [void][DVN.VN]::SetLayeredWindowAttributes($ov, 0, $a, 0x2)
      Start-Sleep -Milliseconds 60
    }
  } catch { }
  finally {
    if ($ov -ne [IntPtr]::Zero) { [void][DVN.VN]::DestroyWindow($ov) }
  }
}