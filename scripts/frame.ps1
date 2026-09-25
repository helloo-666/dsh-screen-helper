param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 100,
  [int]$H = 100,
  [int]$Ms = 900
)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# 元素/窗口高亮框：青色三重描边，点击穿透、不激活、渐隐
$inset = 6
$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsbox-frame'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($X - $inset, $Y - $inset)
$form.Size = New-Object System.Drawing.Size($W + $inset * 2, $H + $inset * 2)
$form.BackColor = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta
$form.TopMost = $true
$form.ShowInTaskbar = $false

$form.Add_Paint({
  param($s, $e)
  $g = $e.Graphics
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 0, 229, 255), 4)
  for ($i = 0; $i -lt 3; $i++) {
    $ins = $inset + $i * 3
    $g.DrawRectangle($pen, $ins, $ins, $form.Width - 1 - 2 * $ins, $form.Height - 1 - 2 * $ins)
  }
  $pen.Dispose()
})

$form.Show()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while ($sw.ElapsedMilliseconds -lt $Ms) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 60
}
for ($o = 100; $o -ge 0; $o -= 25) {
  $form.Opacity = $o / 100.0
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 45
}
$form.Close()
