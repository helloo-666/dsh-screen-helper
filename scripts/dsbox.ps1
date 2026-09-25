#Requires -Version 5.1
# dsbox - fast local screen automation CLI (zero dependencies)
# WinRT OCR + GDI+ capture + Win32 messages, all built into Windows.
# Output contract: exit 0 = success (stdout JSON); exit 2 = usage error; exit 1 = runtime error.
param()

$ErrorActionPreference = 'Stop'

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
  Show-WindowFrame $t.handle $t.rect 1200
  $failed = 0
  foreach ($ch in $text.ToCharArray()) {
    $r = [IntPtr]::Zero
    $sent = [N]::SendMessageTimeout($deepest, 0x0102, [IntPtr][int][char]$ch, [IntPtr]::Zero, [N]::SMTO_ABORTIFHUNG, 2000, [ref]$r)
    if (-not $sent) { $failed++ }
    Start-Sleep -Milliseconds 8
  }
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
    if ($rest.Count -lt 2) { Fail "usage: dsbox mouse click|scroll ..." 2 }
    if ($rest[1] -eq 'click') { Cmd-MouseClick @($rest[2..($rest.Count-1)]) }
    elseif ($rest[1] -eq 'scroll') { Cmd-MouseScroll @($rest[2..($rest.Count-1)]) }
    else { Fail "unknown mouse subcommand '$($rest[1])'" 2 }
  }
  'keyboard' {
    if ($rest.Count -lt 2 -or $rest[1] -ne 'write') { Fail 'usage: dsbox keyboard write --text T [--point x,y] --hwnd H | --title T' 2 }
    Cmd-KeyboardWrite @($rest[2..($rest.Count-1)])
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
    # ui find / ui tree: UIA tree access is not implemented in dsbox; report a
    # structured not-found so the plugin's identity step falls through to OCR
    # instead of dying on a usage error.
    if ($rest.Count -ge 2 -and $rest[1] -eq 'find') {
      Write-JsonOut @{ ok = $true; status = 'not_found'; count = 0; matches = @() }
    } else {
      Fail "dsbox ui supports only 'find' (degraded); use find_exact/OCR instead" 2
    }
  }
  'health' { Cmd-Health }
  default { Fail "unknown command '$($rest[0])'" 2 }
}
