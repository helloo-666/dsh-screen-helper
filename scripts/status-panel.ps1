param([string]$Title = 'AI 任务', [string]$StateFile = '')
$Title = $Title.Trim(@("'", '"'))
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Name RD -Namespace DRD -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags); [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v); [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int val, int size);'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'AI'
$form.Size = New-Object System.Drawing.Size(400, 120)
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(760, 12)
$form.TopMost = $true
$form.FormBorderStyle = 'None'
$form.BackColor = [System.Drawing.Color]::FromArgb(28, 28, 32)
$form.ShowInTaskbar = $false

$radius = 16
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)
$path.AddArc($form.ClientSize.Width - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)
$path.AddArc($form.ClientSize.Width - $radius * 2, $form.ClientSize.Height - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$path.AddArc(0, $form.ClientSize.Height - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$path.CloseFigure()
$form.Region = New-Object System.Drawing.Region($path)

try {
  $attr = 2
  $pref = 1
  [void][DRD.RD]::DwmSetWindowAttribute($form.Handle, $attr, [ref]$pref, 4)
} catch { }

$lblAI = New-Object System.Windows.Forms.Label
$lblAI.Text = 'AI'
$lblAI.ForeColor = [System.Drawing.Color]::FromArgb(255, 255, 170, 40)
$lblAI.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$lblAI.Location = New-Object System.Drawing.Point(20, 12)
$lblAI.AutoSize = $true
$form.Controls.Add($lblAI)

$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = $Title
$lblTitle.ForeColor = [System.Drawing.Color]::White
$lblTitle.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$lblTitle.Location = New-Object System.Drawing.Point(48, 13)
$lblTitle.AutoSize = $true
$form.Controls.Add($lblTitle)

$lblStep = New-Object System.Windows.Forms.Label
$lblStep.Text = '准备中…'
$lblStep.ForeColor = [System.Drawing.Color]::FromArgb(255, 200, 200, 210)
$lblStep.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$lblStep.Location = New-Object System.Drawing.Point(20, 48)
$lblStep.AutoSize = $true
$form.Controls.Add($lblStep)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Style = 'Continuous'
$progress.Location = New-Object System.Drawing.Point(20, 84)
$progress.Size = New-Object System.Drawing.Size(360, 6)
$progress.Value = 0
$form.Controls.Add($progress)

$form.Show()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 300
$timer.Add_Tick({
  if (Test-Path $StateFile) {
    try {
      $raw = [System.IO.File]::ReadAllText($StateFile)
      if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
      $st = $raw | ConvertFrom-Json
      $lblStep.Text = $st.step
      $progress.Value = [Math]::Min(100, [int](($st.done / [Math]::Max(1, $st.total)) * 100))
      if ($st.finished) {
        Start-Sleep -Milliseconds 2500
        $form.Close()
      }
    } catch { }
  }
})
$timer.Start()

$topTimer = New-Object System.Windows.Forms.Timer
$topTimer.Interval = 1000
$topTimer.Add_Tick({
  [void][DRD.RD]::SetWindowPos($form.Handle, [IntPtr](-1), 0, 0, 0, 0, 0x0043)
})
$topTimer.Start()

[System.Windows.Forms.Application]::Run($form)
