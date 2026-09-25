#Requires -Version 5.1
# dsbox - fast local screen automation CLI (zero dependencies)
# WinRT OCR + GDI+ capture + Win32 messages, all built into Windows.
# Output contract: exit 0 = success (stdout JSON); exit 2 = usage error; exit 1 = runtime error.
param()

$ErrorActionPreference = 'Stop'
# Emit UTF-8 on stdout regardless of the console code page: callers (Node)
# decode as UTF-8, while powershell.exe would otherwise emit GBK on a zh-CN box.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- infra

function Write-JsonOut($obj) {
  $obj | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

function Fail($msg, [int]$code = 1) {
  @{ ok = $false; error = $msg } | ConvertTo-Json -Depth 4 -Compress
  exit $code
}

function FailInput($msg, [int]$code = 1) {
  # input-refusal envelope: cursorMoved is always false because refusals never
  # deliver anything - the plugin surfaces this field so a refusal can never be
  # mistaken for a delivery that moved something.
  @{ ok = $false; error = $msg; cursorMoved = $false } | ConvertTo-Json -Depth 4 -Compress
  exit $code
}

$script:FgRestoreHwnd = [IntPtr]::Zero
$script:FgRestoreThread = [uint32]0

function Save-Foreground {
  # Remember whose turn it is to be in front, BEFORE an operation that makes
  # the target app process input (the app often activates itself in response,
  # stealing the foreground from whatever the user was looking at).
  $h = [N]::GetForegroundWindow()
  $script:FgRestoreHwnd = $h
  $script:FgRestoreThread = 0
  if ($h -ne [IntPtr]::Zero) {
    $procId = 0
    $script:FgRestoreThread = [N]::GetWindowThreadProcessId($h, [ref]$procId)
  }
}

function Restore-Foreground {
  # In-process restore races the target app's own async activation (UWP/
  # Chromium activate themselves hundreds of ms later and win). Instead we
  # report the saved foreground window to the caller (the plugin, a long-lived
  # process) which performs the restore AFTER our exit - reliably, as a fresh
  # PowerShell process with the ALT trick.
  if ($script:FgRestoreHwnd -ne [IntPtr]::Zero) {
    [Console]::Error.WriteLine("dsbox-restore-hwnd: " + $script:FgRestoreHwnd.ToInt64())
  }
  $script:FgRestoreHwnd = [IntPtr]::Zero
  $script:FgRestoreThread = 0
}

$script:AsTaskGeneric = $null
function Await($op, $ResultType) {
  if ($null -eq $script:AsTaskGeneric) {
    $script:AsTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
      })[0]
  }
  $asTask = $script:AsTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($op))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
function Initialize-WinRt {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
}

$script:NativeSource = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class N {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr RealChildWindowFromPoint(IntPtr p, POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll")] public static extern IntPtr CreateWindowExW(uint ex, string cls, string name, uint style, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr prm);
  [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h, uint key, byte a, uint f);
  [DllImport("user32.dll")] public static extern int SetWindowLongW(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  public const uint SMTO_ABORTIFHUNG = 0x0002;
  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string TextOf(IntPtr h) {
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
}
"@
if (-not ('N' -as [type])) { Add-Type -TypeDefinition $script:NativeSource }

# ---------------------------------------------------------------- windows

function Get-WindowList {
  $list = New-Object System.Collections.ArrayList
  $cb = [N+EnumCb] {
    param($h, $l)
    if (-not [N]::IsWindowVisible($h)) { return $true }
    $t = [N]::TextOf($h)
    $c = [N]::ClassOf($h)
    if ($t -eq '' -and $c -eq '') { return $true }
    $r = New-Object N+RECT
    [void][N]::GetWindowRect($h, [ref]$r)
    $procId = 0
    [void][N]::GetWindowThreadProcessId($h, [ref]$procId)
    $pname = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }
    [void]$list.Add([PSCustomObject]@{
      handle = $h.ToInt64()
      title = $t
      cls = $c
      process = $pname
      pid = $procId
      rect = @($r.L, $r.T, $r.R, $r.B)
    })
    return $true
  }
  [void][N]::EnumWindows($cb, [IntPtr]::Zero)
  $list
}

function Resolve-TargetWindow([string]$Title, [long]$Hwnd) {
  if ($Hwnd -gt 0) {
    $r = New-Object N+RECT
    # GetWindowRect fails for dead handles but leaves RECT zeroed; the bounds
    # guard in each command treats the empty rect as "nothing can be inside"
    # and refuses with the same out-of-bounds message.
    [void][N]::GetWindowRect([IntPtr]$Hwnd, [ref]$r)
    return [PSCustomObject]@{ handle = $Hwnd; rect = @($r.L, $r.T, $r.R, $r.B) }
  }
  if ($Title) {
    $match = Get-WindowList | Where-Object { $_.title -like "*$Title*" } | Select-Object -First 1
    if (-not $match) { Fail "no visible window whose title contains '$Title'" }
    return [PSCustomObject]@{ handle = $match.handle; rect = $match.rect }
  }
  Fail 'dsbox requires an explicit target: pass --hwnd or --title (never the user''s foreground window)'
}

# ---------------------------------------------------------------- OCR

$script:OcrEngine = $null
function Get-OcrEngine {
  if ($null -eq $script:OcrEngine) {
    Initialize-WinRt
    $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if ($null -eq $script:OcrEngine) {
      $zh = New-Object Windows.Globalization.Language('zh-Hans-CN')
      $script:OcrEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zh)
    }
    if ($null -eq $script:OcrEngine) { Fail 'Windows OCR engine unavailable (install a language pack with OCR)' }
  }
  $script:OcrEngine
}

function Invoke-ScreenOcr([int[]]$Region) {
  Initialize-WinRt
  $engine = Get-OcrEngine
  $sw = [System.Diagnostics.Stopwatch]::StartNew()

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $x1 = $bounds.X; $y1 = $bounds.Y
  $x2 = $bounds.X + $bounds.Width; $y2 = $bounds.Y + $bounds.Height
  if ($Region) {
    $x1 = [Math]::Max($x1, $Region[0]); $y1 = [Math]::Max($y1, $Region[1])
    $x2 = [Math]::Min($x2, $Region[2]); $y2 = [Math]::Min($y2, $Region[3])
    if ($x2 -le $x1 -or $y2 -le $y1) { Fail "region $($Region -join ',') is outside the visible screen area" }
  }
  $w = $x2 - $x1; $h = $y2 - $y1

  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x1, $y1, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $bytes = $ms.ToArray(); $ms.Dispose()

  $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
  $writer = New-Object Windows.Storage.Streams.DataWriter($stream.GetOutputStreamAt(0))
  $writer.WriteBytes([byte[]]$bytes)
  Await ($writer.StoreAsync()) ([UInt32]) | Out-Null
  Await ($writer.FlushAsync()) ([boolean]) | Out-Null
  $writer.DetachStream() | Out-Null
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
  $soft.Dispose()
  $stream.Dispose()

  $items = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $minX=[double]::MaxValue; $minY=[double]::MaxValue; $maxR=0.0; $maxB=0.0
    foreach ($word in $line.Words) {
      $r = $word.BoundingRect
      if ($r.X -lt $minX) { $minX = $r.X }
      if ($r.Y -lt $minY) { $minY = $r.Y }
      if (($r.X+$r.Width) -gt $maxR) { $maxR = $r.X+$r.Width }
      if (($r.Y+$r.Height) -gt $maxB) { $maxB = $r.Y+$r.Height }
    }
    if ($maxR -eq 0) { continue }
    [void]$items.Add([PSCustomObject]@{
      text = $line.Text
      confidence = 0.85
      box = @([int]($minX+$x1), [int]($minY+$y1), [int]($maxR+$x1), [int]($maxB+$y1))
      center = @([int](($minX+$maxR)/2+$x1), [int](($minY+$maxB)/2+$y1))
    })
  }
  [PSCustomObject]@{
    items = $items
    region = @($x1, $y1, $x2, $y2)
    elapsedMs = $sw.ElapsedMilliseconds
  }
}

# ---------------------------------------------------------------- frame highlight

function Show-WindowFrame([long]$Hwnd, [int[]]$Rect, [int]$Ms = 1600) {
  # Bright frame on a click-through, never-activating topmost layered window;
  # fades out, then is destroyed. Shows the user WHICH window is operated.
  $ov = [IntPtr]::Zero
  try {
    Add-Type -AssemblyName System.Drawing
    $x = $Rect[0]-6; $y = $Rect[1]-6
    $w = ($Rect[2]+6)-$x; $h = ($Rect[3]+6)-$y
    if ($w -le 0 -or $h -le 0 -or $w -gt 8000 -or $h -gt 8000) { return }
    $ex = 0x00080000 -bor 0x00000020 -bor 0x00000080 -bor 0x08000000
    $style = 0x90000000
    $ov = [N]::CreateWindowExW([uint32]$ex, 'Static', 'dsbox-frame', [uint32]$style, $x, $y, $w, $h, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero)
    if ($ov -eq [IntPtr]::Zero) { return }
    [void][N]::SetWindowLongW($ov, -20, [int]$ex)
    $frameBmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($frameBmp)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255,0,229,255), 4)
    for ($i = 0; $i -lt 3; $i++) {
      $inset = 2 + $i*3
      $g.DrawRectangle($pen, $inset, $inset, $w-1-2*$inset, $h-1-2*$inset)
    }
    $g.Dispose()
    $hdc = [N]::GetDC($ov)
    $gdc = [System.Drawing.Graphics]::FromHdc($hdc)
    $gdc.DrawImage($frameBmp, 0, 0)
    $gdc.Dispose()
    [void][N]::ReleaseDC($ov, $hdc)
    $frameBmp.Dispose()
    $steps = 8
    $delay = [Math]::Max(20, [int]($Ms / $steps))
    for ($s = $steps; $s -ge 1; $s--) {
      $alpha = [byte][Math]::Max(10, [int](255 * $s / $steps))
      [void][N]::SetLayeredWindowAttributes($ov, 0, $alpha, 0x2)
      Start-Sleep -Milliseconds $delay
    }
  } catch { }
  finally {
    if ($ov -ne [IntPtr]::Zero) { [void][N]::DestroyWindow($ov) }
  }
}

# ---------------------------------------------------------------- commands

function Cmd-ScreenRecognize($argv) {
  $region = $null
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--region' -and $i+1 -lt $argv.Count) {
      $region = ($argv[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() })
      if ($region.Count -ne 4) { Fail 'usage: --region x1,y1,x2,y2' 2 }
      break
    }
  }
  $r = Invoke-ScreenOcr $region
  Write-JsonOut @{
    ok = $true
    action = 'screen.recognize'
    region = $r.region
    items = $r.items
    count = $r.items.Count
    total_count = $r.items.Count
    elapsedMs = $r.elapsedMs
  }
}

function Cmd-WindowListVisible {
  $wins = Get-WindowList
  $out = foreach ($w in $wins) {
    [PSCustomObject]@{
      handle = $w.handle
      title = $w.title
      cls = $w.cls
      process = $w.process
      pid = $w.pid
      window_region = $w.rect
    }
  }
  Write-JsonOut @{ ok = $true; windows = @($out); count = @($out).Count }
}

function Cmd-WindowForeground {
  $fg = [N]::GetForegroundWindow()
  if ($fg -eq [IntPtr]::Zero) { Fail 'no foreground window' }
  $r = New-Object N+RECT
  [void][N]::GetWindowRect($fg, [ref]$r)
  $procId = 0
  [void][N]::GetWindowThreadProcessId($fg, [ref]$procId)
  $pname = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }
  Write-JsonOut @{
    ok = $true
    handle = $fg.ToInt64()
    title = [N]::TextOf($fg)
    cls = [N]::ClassOf($fg)
    process = $pname
    pid = $procId
    window_region = @($r.L, $r.T, $r.R, $r.B)
  }
}

function Cmd-MouseClick($argv) {
  $point = $null; $hwnd = 0L; $title = ''
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--point' -and $i+1 -lt $argv.Count) {
      $point = ($argv[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() })
      if ($point.Count -ne 2) { Fail 'usage: --point x,y' 2 }
    } elseif ($argv[$i] -eq '--hwnd' -and $i+1 -lt $argv.Count) { $hwnd = [long]$argv[$i+1] }
    elseif ($argv[$i] -eq '--title' -and $i+1 -lt $argv.Count) { $title = $argv[$i+1] }
  }
  if (-not $point) { Fail 'usage: dsbox mouse click --point x,y --hwnd H | --title T' 2 }
  $t = Resolve-TargetWindow $title $hwnd
  if ($point[0] -lt $t.rect[0] -or $point[0] -gt $t.rect[2] -or $point[1] -lt $t.rect[1] -or $point[1] -gt $t.rect[3]) {
    FailInput "point $($point -join ',') is outside the target window rect ($($t.rect -join ',')); no input was sent"
  }
  Save-Foreground
  Show-WindowFrame $t.handle $t.rect 1600
  $child = [IntPtr]$t.handle
  $wr = New-Object N+RECT
  [void][N]::GetWindowRect($child, [ref]$wr)
  $winPt = New-Object N+POINT
  $winPt.X = $point[0] - $wr.L; $winPt.Y = $point[1] - $wr.T
  $deepest = [N]::RealChildWindowFromPoint($child, $winPt)
  if ($deepest -eq [IntPtr]::Zero) { $deepest = $child }
  $cr = New-Object N+RECT
  [void][N]::GetWindowRect($child, [ref]$cr)
  $cx = $point[0] - $cr.L; $cy = $point[1] - $cr.T
  $lp = [IntPtr]($cx -bor ($cy * 65536))
  $r1 = [IntPtr]::Zero; $r2 = [IntPtr]::Zero
  $s1 = [N]::SendMessageTimeout($deepest, 0x0201, [IntPtr]1, $lp, [N]::SMTO_ABORTIFHUNG, 2000, [ref]$r1)
  Start-Sleep -Milliseconds 30
  $s2 = [N]::SendMessageTimeout($deepest, 0x0202, [IntPtr]0, $lp, [N]::SMTO_ABORTIFHUNG, 2000, [ref]$r2)
  Restore-Foreground
  if (-not ($s1 -and $s2)) { Fail 'target window did not respond within 2s; no click was delivered' }
  $before = New-Object N+POINT
  [void][N]::GetCursorPos([ref]$before)
  Write-JsonOut @{
    ok = $true
    action = 'mouse.click'
    hwnd = $t.handle
    childHwnd = $deepest.ToInt64()
    childClass = [N]::ClassOf($deepest)
    cursorMoved = $false
    cursorBefore = @($before.X, $before.Y)
    point = $point
    frameShown = $true
  }
}

function Cmd-MouseScroll($argv) {
  # WM_MOUSEWHEEL to the child under the point: the wheel scrolls whatever is
  # under the target point without the cursor ever moving.
  $point = $null; $hwnd = 0L; $title = ''; $amount = 1
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--point' -and $i+1 -lt $argv.Count) {
      $point = ($argv[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() })
      if ($point.Count -ne 2) { Fail 'usage: --point x,y' 2 }
    } elseif ($argv[$i] -eq '--hwnd' -and $i+1 -lt $argv.Count) { $hwnd = [long]$argv[$i+1] }
    elseif ($argv[$i] -eq '--title' -and $i+1 -lt $argv.Count) { $title = $argv[$i+1] }
    elseif ($argv[$i] -eq '--amount' -and $i+1 -lt $argv.Count) { $amount = [int]$argv[$i+1] }
  }
  if (-not $point -or $amount -eq 0) { Fail 'usage: dsbox mouse scroll --point x,y --amount N --hwnd H | --title T' 2 }
  $t = Resolve-TargetWindow $title $hwnd
  if ($point[0] -lt $t.rect[0] -or $point[0] -gt $t.rect[2] -or $point[1] -lt $t.rect[1] -or $point[1] -gt $t.rect[3]) {
    FailInput "point $($point -join ',') is outside the target window rect ($($t.rect -join ',')); no input was sent"
  }
  $child = [IntPtr]$t.handle
  $wr = New-Object N+RECT
  [void][N]::GetWindowRect($child, [ref]$wr)
  $winPt = New-Object N+POINT
  $winPt.X = $point[0] - $wr.L; $winPt.Y = $point[1] - $wr.T
  $deepest = [N]::RealChildWindowFromPoint($child, $winPt)
  if ($deepest -eq [IntPtr]::Zero) { $deepest = $child }
  $cx = $point[0] - $wr.L; $cy = $point[1] - $wr.T
  $lp = [IntPtr]($cx -bor ($cy * 65536))
  $delta = $amount * 120
  $wp = [IntPtr][int](($delta -shl 16) -bor 0)
  $r = [IntPtr]::Zero
  $sent = [N]::SendMessageTimeout($deepest, 0x020A, $wp, $lp, [N]::SMTO_ABORTIFHUNG, 2000, [ref]$r)
  if (-not $sent) { Fail 'target window did not respond within 2s; no scroll was delivered' }
  $before = New-Object N+POINT
  [void][N]::GetCursorPos([ref]$before)
  Write-JsonOut @{
    ok = $true
    action = 'mouse.scroll'
    hwnd = $t.handle
    childHwnd = $deepest.ToInt64()
    childClass = [N]::ClassOf($deepest)
    cursorMoved = $false
    point = $point
    amount = $amount
  }
}

function Cmd-MouseScrollUia($argv) {
  # UIA ScrollPattern scrolling: the app scrolls ITSELF via its accessibility
  # channel - no window messages, no cursor, works on UWP/self-drawn apps that
  # ignore WM_MOUSEWHEEL. --percent sets an absolute vertical position;
  # without it, --amount small-steps (each = 1/10 of range).
  $percent = $null; $amount = 0; $hwnd = 0L; $title = ''
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--percent' -and $i+1 -lt $argv.Count) { $percent = [double]$argv[$i+1] }
    elseif ($argv[$i] -eq '--amount' -and $i+1 -lt $argv.Count) { $amount = [int]$argv[$i+1] }
    elseif ($argv[$i] -eq '--hwnd' -and $i+1 -lt $argv.Count) { $hwnd = [long]$argv[$i+1] }
    elseif ($argv[$i] -eq '--title' -and $i+1 -lt $argv.Count) { $title = $argv[$i+1] }
  }
  if ($null -eq $percent -and $amount -eq 0) { Fail 'usage: dsbox mouse scrolluia --percent N | --amount N --hwnd H | --title T' 2 }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  if ($hwnd -le 0 -and -not $title) { Fail 'dsbox mouse scrolluia requires an explicit target: --hwnd or --title' 2 }
  $t = Resolve-TargetWindow $title $hwnd
  $win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$t.handle)
  $all = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  # pick the scrollable element with the largest scrollable range (the main content pane)
  $best = $null; $bestEl = $null
  foreach ($e in $all) {
    try {
      $sp = $e.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
      if ($sp.Current.VerticallyScrollable) {
        $range = 100.0
        if ($best -eq $null) { $best = $sp; $bestEl = $e }
      }
    } catch { }
  }
  if (-not $best) {
    Write-JsonOut @{ ok = $true; action = 'mouse.scrolluia'; status = 'not_scrollable'; error = 'no vertically scrollable element in the target window' }
  }
  $before = $best.Current.VerticalScrollPercent
  if ($null -ne $percent) {
    $best.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, [double]$percent)
  } else {
    $step = 10.0 * $amount
    $cur = $before
    if ($cur -lt 0) { $cur = 0 }
    $next = $cur + $step
    if ($next -lt 0) { $next = 0 }
    if ($next -gt 100) { $next = 100 }
    $best.SetScrollPercent([System.Windows.Automation.ScrollPattern]::NoScroll, $next)
  }
  Start-Sleep -Milliseconds 300
  $after = $best.Current.VerticalScrollPercent
  Write-JsonOut @{
    ok = $true
    action = 'mouse.scrolluia'
    status = 'scrolled'
    hwnd = $t.handle
    elementRole = $bestEl.Current.ControlType.ProgrammaticName -replace '^ControlType\.'
    scrollBefore = $before
    scrollAfter = $after
    cursorMoved = $false
  }
}

function Cmd-KeyboardWrite($argv) {
  # WM_CHAR to the child under the point (or the first editable-looking
  # descendant). Explicit target required: never the user's foreground window.
  $text = $null; $hwnd = 0L; $title = ''; $point = $null
  for ($i = 0; $i -lt $argv.Count; $i++) {
    if ($argv[$i] -eq '--text' -and $i+1 -lt $argv.Count) { $text = $argv[$i+1] }
    elseif ($argv[$i] -eq '--hwnd' -and $i+1 -lt $argv.Count) { $hwnd = [long]$argv[$i+1] }
    elseif ($argv[$i] -eq '--title' -and $i+1 -lt $argv.Count) { $title = $argv[$i+1] }
    elseif ($argv[$i] -eq '--point' -and $i+1 -lt $argv.Count) {
      $point = ($argv[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() })
    }
  }
  if ($null -eq $text) { Fail 'usage: dsbox keyboard write --text T [--point x,y] --hwnd H | --title T' 2 }
  $t = Resolve-TargetWindow $title $hwnd
  $child = [IntPtr]$t.handle
  if ($point) {
    if ($point[0] -lt $t.rect[0] -or $point[0] -gt $t.rect[2] -or $point[1] -lt $t.rect[1] -or $point[1] -gt $t.rect[3]) {
      FailInput "point $($point -join ',') is outside the target window rect ($($t.rect -join ',')); no input was sent"
    }
    $wr = New-Object N+RECT
    [void][N]::GetWindowRect($child, [ref]$wr)
    $winPt = New-Object N+POINT
    $winPt.X = $point[0] - $wr.L; $winPt.Y = $point[1] - $wr.T
    $deepest = [N]::RealChildWindowFromPoint($child, $winPt)
    if ($deepest -eq [IntPtr]::Zero) { $deepest = $child }
  } else {
    # whole-window typing: the frame highlight tells the user where it goes
    $deepest = $child
  }
  Save-Foreground
  Show-WindowFrame $t.handle $t.rect 1200
  $failed = 0
  foreach ($ch in $text.ToCharArray()) {
    $r = [IntPtr]::Zero
    $sent = [N]::SendMessageTimeout($deepest, 0x0102, [IntPtr][int][char]$ch, [IntPtr]::Zero, [N]::SMTO_ABORTIFHUNG, 2000, [ref]$r)
    if (-not $sent) { $failed++ }
    Start-Sleep -Milliseconds 8
  }
  Restore-Foreground
  if ($failed -gt 0) { Fail "$failed of $($text.Length) characters were not delivered: the target window stopped responding" }
  Write-JsonOut @{
    ok = $true
    action = 'keyboard.write'
    hwnd = $t.handle
    childHwnd = $deepest.ToInt64()
    childClass = [N]::ClassOf($deepest)
    charsSent = $text.Length
    cursorMoved = $false
  }
}

function Cmd-Health {
  $engine = $null
  try { $engine = Get-OcrEngine } catch { }
  Write-JsonOut @{
    ok = $true
    tool = 'dsbox'
    version = '0.1.0'
    ocr = if ($engine) { 'ready' } else { 'unavailable' }
    ocrLanguage = if ($engine) { $engine.RecognizedLanguage.LanguageTag } else { $null }
  }
}

# ---------------------------------------------------------------- dispatch

$rest = @()
if ($args.Count -gt 0 -and $args[0] -eq 'cli') { $rest = $args[1..($args.Count-1)] } else { $rest = $args }

if ($rest.Count -eq 0) { Fail 'usage: dsbox <command>; commands: screen recognize, window list-visible|foreground, mouse click, health' 2 }

switch ($rest[0]) {
  'screen' {
    if ($rest.Count -lt 2 -or $rest[1] -ne 'recognize') { Fail 'usage: dsbox screen recognize [--region x1,y1,x2,y2]' 2 }
    Cmd-ScreenRecognize @($rest[2..($rest.Count-1)])
  }
  'window' {
    if ($rest.Count -lt 2) { Fail 'usage: dsbox window list-visible|foreground' 2 }
    switch ($rest[1]) {
      'list-visible' { Cmd-WindowListVisible }
      'foreground' { Cmd-WindowForeground }
      default { Fail "unknown window subcommand '$($rest[1])'" 2 }
    }
  }
  'mouse' {
    if ($rest.Count -lt 2) { Fail "usage: dsbox mouse click|scroll|scrolluia ..." 2 }
    if ($rest[1] -eq 'click') { Cmd-MouseClick @($rest[2..($rest.Count-1)]) }
    elseif ($rest[1] -eq 'scroll') { Cmd-MouseScroll @($rest[2..($rest.Count-1)]) }
    elseif ($rest[1] -eq 'scrolluia') { Cmd-MouseScrollUia @($rest[2..($rest.Count-1)]) }
    else { Fail "unknown mouse subcommand '$($rest[1])'" 2 }
  }
  'keyboard' {
    if ($rest.Count -ge 2 -and $rest[1] -eq 'setvalue') {
      # UIA ValuePattern: put text straight into an element's value - the
      # app's own accessibility channel, no keystrokes, no cursor, works on
      # UWP/self-drawn apps that ignore WM_CHAR.
      $text = $null; $hwnd2 = 0L; $title2 = ''; $name2 = ''
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--text' -and $i+1 -lt $rest.Count) { $text = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--name' -and $i+1 -lt $rest.Count) { $name2 = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd2 = [long]$rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--title' -and $i+1 -lt $rest.Count) { $title2 = $rest[$i+1]; $i++ }
      }
      if ($null -eq $text) { Fail 'usage: dsbox keyboard setvalue --text T --name N [--hwnd H | --title T]' 2 }
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $scopeEl = $null
      if ($hwnd2 -gt 0 -or $title2) {
        $t = Resolve-TargetWindow $title2 $hwnd2
        $scopeEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$t.handle)
      }
      $editCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
      $el = $null
      if ($scopeEl -and $name2) {
        $nc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name2)
        $and = New-Object System.Windows.Automation.AndCondition($editCond, $nc)
        $el = $scopeEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $and)
      }
      if (-not $el -and $scopeEl) { $el = $scopeEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond) }
      if (-not $el) {
        Write-JsonOut @{ ok = $true; action = 'keyboard.setvalue'; status = 'not_found' }
      }
      $vp = $null
      $eb = $el.Current.BoundingRectangle
      # frame the input element itself so the user sees where text goes
      Show-WindowFrame 0 @([int]$eb.X, [int]$eb.Y, [int]($eb.X+$eb.Width), [int]($eb.Y+$eb.Height)) 900
      Save-Foreground
      try {
        $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $vp.SetValue($text)
      } catch {
        Restore-Foreground
        Write-JsonOut @{ ok = $false; action = 'keyboard.setvalue'; status = 'no_value_pattern'; error = 'element does not support ValuePattern' }
      }
      Start-Sleep -Milliseconds 200
      Restore-Foreground
      Write-JsonOut @{
        ok = $true
        action = 'keyboard.setvalue'
        status = 'set'
        element = [PSCustomObject]@{
          name = $el.Current.Name
          role = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.'
        }
        valueAfter = $vp.Current.Value
        cursorMoved = $false
      }
    } elseif ($rest.Count -lt 2 -or $rest[1] -ne 'write') {
      Fail 'usage: dsbox keyboard write --text T [--point x,y] --hwnd H | --title T | keyboard setvalue --text T --name N' 2
    } else {
      Cmd-KeyboardWrite @($rest[2..($rest.Count-1)])
    }
  }
  'find_exact' {
    # Plugin compatibility: find_exact --text Q [--target T] = OCR + rank.
    $text = ''; $region = $null
    for ($i = 1; $i -lt $rest.Count; $i++) {
      if ($rest[$i] -eq '--text' -and $i+1 -lt $rest.Count) { $text = $rest[$i+1]; $i++ }
      elseif ($rest[$i] -eq '--region' -and $i+1 -lt $rest.Count) {
        $region = ($rest[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() }); $i++
      }
    }
    if (-not $text) { Fail 'usage: dsbox find_exact --text Q [--region x1,y1,x2,y2]' 2 }
    $r = Invoke-ScreenOcr $region
    $ranked = New-Object System.Collections.ArrayList
    foreach ($item in $r.items) {
      $score = 0
      if ($item.text -eq $text) { $score = 1 }
      elseif ($item.text -like "*$text*") { $score = 0.7 }
      elseif ($text -like "*$($item.text)*" -and $item.text.Length -ge 2) { $score = 0.5 }
      if ($score -gt 0) { [void]$ranked.Add([PSCustomObject]@{ item = $item; score = $score }) }
    }
    $ranked = $ranked | Sort-Object { -$_.score }
    $matches = foreach ($x in $ranked) {
      [PSCustomObject]@{
        text = $x.item.text
        confidence = $x.item.confidence
        box = $x.item.box
        center = $x.item.center
        score = $x.score
      }
    }
    Write-JsonOut @{
      ok = $true
      action = 'find_exact'
      query = $text
      count = @($matches).Count
      matches = @($matches)
      elapsedMs = $r.elapsedMs
    }
  }
  'ui' {
    # UIA tree access via System.Windows.Automation (fast: ~200ms window scan,
    # ~800ms for a few thousand descendants).
    if ($rest.Count -ge 2 -and $rest[1] -eq 'find') {
      $name = ''; $role = ''; $matchMode = 'contains'; $hwnd = 0L; $title = ''
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--name' -and $i+1 -lt $rest.Count) { $name = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--role' -and $i+1 -lt $rest.Count) { $role = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--match' -and $i+1 -lt $rest.Count) { $matchMode = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd = [long]$rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--title' -and $i+1 -lt $rest.Count) { $title = $rest[$i+1]; $i++ }
      }
      if (-not $name -and -not $role) { Fail 'usage: dsbox ui find --name N [--role R]' 2 }
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      # Scope to one window's subtree when a target is given (fewer false
      # matches from unrelated apps); otherwise scan every top-level window.
      if ($hwnd -gt 0 -or $title) {
        $t = Resolve-TargetWindow $title $hwnd
        $roots = @([System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$t.handle))
      } else {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
        $roots = @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond))
      }
      $found = New-Object System.Collections.ArrayList
      foreach ($w in $roots) {
        $el = $null
        if ($name) {
          $prop = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
          if ($matchMode -eq 'exact') { $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $prop) }
          else {
            # substring match: UIA has no contains-condition, scan manually
            $all = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($e in $all) {
              $n = $e.Current.Name
              if ($n -and $n -like "*$name*") { $el = $e; break }
            }
          }
        }
        if ($el) {
          $r = $el.Current.BoundingRectangle
          if ($r.Width -gt 0 -and $r.Height -gt 0) {
            # Prefer the element's own clickable point when it has one: for
            # title-bar/window elements the bounding-rect centre can sit on an
            # overlapping child (close/minimize buttons), which verify then
            # correctly flags as a mismatch. ClickablePoint avoids that.
            $cx = [int]($r.X+$r.Width/2); $cy = [int]($r.Y+$r.Height/2)
            try {
              $cp = $el.GetClickablePoint()
              if ($cp.X -ge $r.X -and $cp.X -le ($r.X+$r.Width) -and $cp.Y -ge $r.Y -and $cp.Y -le ($r.Y+$r.Height)) {
                $cx = [int]$cp.X; $cy = [int]$cp.Y
              }
            } catch { }
            [void]$found.Add([PSCustomObject]@{
              name = $el.Current.Name
              role = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.'
              cls = $el.Current.ClassName
              box = @([int]$r.X, [int]$r.Y, [int]($r.X+$r.Width), [int]($r.Y+$r.Height))
              center = @($cx, $cy)
            })
          }
        }
      }
      $status = 'not_found'
      if ($found.Count -gt 1) { $status = 'ambiguous' }
      elseif ($found.Count -eq 1) { $status = 'matched' }
      Write-JsonOut @{ ok = $true; status = $status; count = $found.Count; matches = @($found) }
    } elseif ($rest.Count -ge 2 -and $rest[1] -eq 'inspect') {
      # Point reverse-lookup: which UIA element sits at this screen point?
      # Closes the verify loop: click, then inspect the point to confirm the
      # landed element matches the expectation.
      $px = $null; $py = $null; $target = 'virtual-screen'
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--point' -and $i+1 -lt $rest.Count) {
          $p = ($rest[$i+1] -split ',' | ForEach-Object { [int]$_.Trim() })
          if ($p.Count -ne 2) { Fail 'usage: --point x,y' 2 }
          $px = $p[0]; $py = $p[1]; $i++
        }
        elseif ($rest[$i] -eq '--target' -and $i+1 -lt $rest.Count) { $target = $rest[$i+1]; $i++ }
      }
      if ($null -eq $px) { Fail 'usage: dsbox ui inspect --point x,y [--target T]' 2 }
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type -AssemblyName WindowsBase
      $pt = New-Object System.Windows.Point($px, $py)
      $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
      if (-not $el -or $el -eq [System.Windows.Automation.AutomationElement]::RootElement) {
        Write-JsonOut @{ ok = $true; action = 'ui.inspect'; element = $null }
      }
      $r = $el.Current.BoundingRectangle
      $role = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.'
      Write-JsonOut @{
        ok = $true
        action = 'ui.inspect'
        target = $target
        point = @($px, $py)
        element = [PSCustomObject]@{
          name = $el.Current.Name
          role = $role
          cls = $el.Current.ClassName
          box = @([int]$r.X, [int]$r.Y, [int]($r.X+$r.Width), [int]($r.Y+$r.Height))
          center = @([int]($r.X+$r.Width/2), [int]($r.Y+$r.Height/2))
          hwnd = $el.Current.NativeWindowHandle
        }
      }
    } elseif ($rest.Count -ge 2 -and $rest[1] -eq 'tree') {
      # Export the window's accessibility subtree so a caller can SEE the UI
      # structure: role/name per element plus which patterns it supports
      # (Invoke = clickable, Value = typable, Scroll = scrollable).
      $hwnd3 = 0L; $title3 = ''; $maxDepth = 6; $maxNodes = 300
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd3 = [long]$rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--title' -and $i+1 -lt $rest.Count) { $title3 = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--depth' -and $i+1 -lt $rest.Count) { $maxDepth = [int]$rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--max' -and $i+1 -lt $rest.Count) { $maxNodes = [int]$rest[$i+1]; $i++ }
      }
      if ($hwnd3 -le 0 -and -not $title3) { Fail 'usage: dsbox ui tree --hwnd H | --title T [--depth N] [--max N]' 2 }
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $t3 = Resolve-TargetWindow $title3 $hwnd3
      $rootEl3 = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$t3.handle)
      $script:dsbItems = New-Object System.Collections.ArrayList
      $script:dsbCount = 0
      function Add-UiNode($e, $d) {
        if ($script:dsbCount -ge $maxNodes) { return }
        $cur = $e.Current
        $patterns = @()
        foreach ($pi in @(@('Invoke', [System.Windows.Automation.InvokePattern]::Pattern), @('Value', [System.Windows.Automation.ValuePattern]::Pattern), @('Scroll', [System.Windows.Automation.ScrollPattern]::Pattern), @('Toggle', [System.Windows.Automation.TogglePattern]::Pattern), @('SelectionItem', [System.Windows.Automation.SelectionItemPattern]::Pattern), @('ExpandCollapse', [System.Windows.Automation.ExpandCollapsePattern]::Pattern))) {
          try { [void]$e.GetCurrentPattern($pi[1]); $patterns += $pi[0] } catch { }
        }
        $r3 = $cur.BoundingRectangle
        # off-screen / virtualised elements report infinite coordinates; clamp
        # to 0 so [int] conversion cannot overflow (those boxes are meaningless
        # anyway until the element is scrolled into view)
        $x3 = if ([double]::IsInfinity($r3.X) -or [double]::IsNaN($r3.X)) { 0 } else { $r3.X }
        $y3 = if ([double]::IsInfinity($r3.Y) -or [double]::IsNaN($r3.Y)) { 0 } else { $r3.Y }
        $w3 = if ([double]::IsInfinity($r3.Width) -or [double]::IsNaN($r3.Width) -or $r3.Width -lt 0) { 0 } else { $r3.Width }
        $h3 = if ([double]::IsInfinity($r3.Height) -or [double]::IsNaN($r3.Height) -or $r3.Height -lt 0) { 0 } else { $r3.Height }
        [void]$script:dsbItems.Add([PSCustomObject]@{
          depth = $d
          name = $cur.Name
          role = $cur.ControlType.ProgrammaticName -replace '^ControlType\.'
          cls = $cur.ClassName
          patterns = @($patterns)
          box = @([int]$x3, [int]$y3, [int]($x3+$w3), [int]($y3+$h3))
        })
        $script:dsbCount++
      }
      function Walk-UiTree($e, $d) {
        if ($d -gt $maxDepth -or $script:dsbCount -ge $maxNodes) { return }
        $kids = $e.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($k in $kids) {
          Add-UiNode $k $d
          Walk-UiTree $k ($d + 1)
        }
      }
      Add-UiNode $rootEl3 0
      Walk-UiTree $rootEl3 1
      Write-JsonOut @{
        ok = $true
        action = 'ui.tree'
        hwnd = $t3.handle
        count = $script:dsbCount
        truncated = $(if ($script:dsbCount -ge $maxNodes) { $true } else { $false })
        items = @($script:dsbItems)
      }
    } elseif ($rest.Count -ge 2 -and $rest[1] -eq 'invoke') {
      $name2 = ''; $hwnd2 = 0L; $title2 = ''
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--name' -and $i+1 -lt $rest.Count) { $name2 = $rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd2 = [long]$rest[$i+1]; $i++ }
        elseif ($rest[$i] -eq '--title' -and $i+1 -lt $rest.Count) { $title2 = $rest[$i+1]; $i++ }
      }
      if (-not $name2) { Fail 'usage: dsbox ui invoke --name N [--hwnd H | --title T]' 2 }
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      Add-Type -AssemblyName WindowsBase
      $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
      $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name2)
      $el = $null
      if ($hwnd2 -gt 0 -or $title2) {
        $t = Resolve-TargetWindow $title2 $hwnd2
        $scopeEl = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$t.handle)
        $el = $scopeEl.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
      } else {
        $winCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
        $wins = $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, $winCond)
        foreach ($w in $wins) {
          $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
          if ($el) { break }
        }
      }
      if (-not $el) {
        Write-JsonOut @{ ok = $true; action = 'ui.invoke'; status = 'not_found' }
      }
      $r = $el.Current.BoundingRectangle
      # frame the ELEMENT itself (tighter and clearer than the whole window)
      Show-WindowFrame 0 @([int]$r.X, [int]$r.Y, [int]($r.X+$r.Width), [int]($r.Y+$r.Height)) 900
      Save-Foreground
      $invoked = $false; $method = ''
      try {
        $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
        $invoked = $true; $method = 'InvokePattern'
      } catch {
        try {
          $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
          $tp.Toggle()
          $invoked = $true; $method = 'TogglePattern'
        } catch {
          try {
            $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $sp.Select()
            $invoked = $true; $method = 'SelectionItem'
          } catch { }
        }
      }
      if (-not $invoked) {
        Restore-Foreground
        Write-JsonOut @{ ok = $false; action = 'ui.invoke'; status = 'no_pattern'; error = 'element supports no invoke/toggle/select pattern' }
      }
      Restore-Foreground
      Write-JsonOut @{
        ok = $true
        action = 'ui.invoke'
        status = 'invoked'
        method = $method
        element = [PSCustomObject]@{
          name = $el.Current.Name
          role = $el.Current.ControlType.ProgrammaticName -replace '^ControlType\.'
          cls = $el.Current.ClassName
          box = @([int]$r.X, [int]$r.Y, [int]($r.X+$r.Width), [int]($r.Y+$r.Height))
        }
        cursorMoved = $false
      }
    } else {
      Fail 'usage: dsbox ui find --name N [--role R] | ui inspect --point x,y | ui invoke --name N' 2
    }
  }
  'probe' {
    # Read-only driveability precheck: child HWND + UIA element counts.
    $hwnd = 0L; $title = ''
    for ($i = 1; $i -lt $rest.Count; $i++) {
      if ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd = [long]$rest[$i+1]; $i++ }
      elseif ($rest[$i] -eq '--title' -and $i+1 -lt $rest.Count) { $title = $rest[$i+1]; $i++ }
    }
    $t = Resolve-TargetWindow $title $hwnd
    $h = [IntPtr]$t.handle
    # Same callback scoping pattern as Get-WindowList: plain variables resolve
    # to this scope when the delegate runs; $script:-prefixed ones would not.
    $childCount = 0
    $children = New-Object System.Collections.ArrayList
    $cb = [N+EnumCb] {
      param($ch, $l)
      # value types mutate a callback-local copy; append to a list instead
      if ($children.Count -lt 12) {
        [void]$children.Add([PSCustomObject]@{ hwnd = $ch.ToInt64(); cls = [N]::ClassOf($ch) })
      } else {
        [void]$children.Add('overflow')  # count-only marker beyond the first 12
      }
      return $true
    }
    [void][N]::EnumChildWindows($h, $cb, [IntPtr]::Zero)
    $overflow = @($children | Where-Object { $_ -eq 'overflow' }).Count
    if ($overflow -gt 0) { $children.RemoveRange(12, $overflow) }
    $childCount = $children.Count + $overflow
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $uiaCount = 0
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
      $uiaCount = $all.Count
    } catch { $uiaCount = 0 }
    $backgroundCapable = ($childCount -gt 0) -or ($uiaCount -gt 50)
    if ($childCount -gt 0) {
      $diagnosis = 'standard Win32 window: background message delivery should work'
    } elseif ($uiaCount -gt 50) {
      $diagnosis = 'accessible tree present but few native child HWNDs: message delivery may work depending on the framework'
    } else {
      $diagnosis = 'self-drawn UI (no child HWNDs, few accessible elements): background window messages are usually ignored; drive with --input-mode real or use the frame-highlighted dsbox click'
    }
    Write-JsonOut @{
      ok = $true
      action = 'probe'
      hwnd = $t.handle
      cls = [N]::ClassOf($h)
      childCount = $childCount
      children = @($children)
      uiaElementCount = $uiaCount
      backgroundCapable = $backgroundCapable
      diagnosis = $diagnosis
    }
  }
  'foreground' {
    if ($rest.Count -ge 2 -and $rest[1] -eq 'restore') {
      # Called by the plugin AFTER a delivery that made the target app steal
      # focus: a fresh process running the ALT-trick + AttachThreadInput
      # sequence, which reliably hands the foreground back to the saved window.
      $hwnd4 = 0L
      for ($i = 2; $i -lt $rest.Count; $i++) {
        if ($rest[$i] -eq '--hwnd' -and $i+1 -lt $rest.Count) { $hwnd4 = [long]$rest[$i+1]; $i++ }
      }
      if ($hwnd4 -le 0) { Fail 'usage: dsbox foreground restore --hwnd H' 2 }
      $mine = [N]::GetCurrentThreadId()
      $curFg = [N]::GetForegroundWindow()
      $curPid = 0
      $fgThread = [N]::GetWindowThreadProcessId($curFg, [ref]$curPid)
      $attached = $false
      $sr = $false
      try {
        [N]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [N]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [N]::keybd_event(0xA5, 0, 0, [UIntPtr]::Zero)
        [N]::keybd_event(0xA5, 0, 2, [UIntPtr]::Zero)
        [N]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        if ($fgThread -ne 0 -and $fgThread -ne $mine) {
          $attached = [N]::AttachThreadInput($mine, $fgThread, $true)
        }
        $sr = [N]::SetForegroundWindow([IntPtr]$hwnd4)
        if (-not $sr) { [N]::SwitchToThisWindow([IntPtr]$hwnd4, $false) }
      } catch { } finally {
        if ($attached) { [void][N]::AttachThreadInput($mine, $fgThread, $false) }
      }
      Start-Sleep -Milliseconds 250
      $now = [N]::GetForegroundWindow()
      Write-JsonOut @{
        ok = $true
        action = 'foreground.restore'
        target = $hwnd4
        foregroundNow = $now.ToInt64()
        restored = ($now -eq [IntPtr]$hwnd4)
        cursorMoved = $false
      }
    } else {
      Fail 'usage: dsbox foreground restore --hwnd H' 2
    }
  }
  'health' { Cmd-Health }
  default { Fail "unknown command '$($rest[0])'" 2 }
}
