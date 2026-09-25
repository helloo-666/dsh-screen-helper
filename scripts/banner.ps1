param([string]$Text='AI 正在使用你的电脑', [int]$Ms=2000)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form = New-Object System.Windows.Forms.Form
$form.Text = 'dsbox-banner'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point($wa.X, $wa.Y)
$form.Size = New-Object System.Drawing.Size($wa.Width, 36)
$form.BackColor = [System.Drawing.Color]::FromArgb(0, 103, 192)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = $Text + '  ·  Esc 取消'
$lbl.ForeColor = [System.Drawing.Color]::White
$lbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$lbl.AutoSize = $false
$lbl.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$lbl.Dock = [System.Windows.Forms.DockStyle]::Fill
$form.Controls.Add($lbl)
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