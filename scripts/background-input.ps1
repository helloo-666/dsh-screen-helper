#requires -Version 5.1
<#
.SYNOPSIS
  background-input.ps1 — drive a window WITHOUT moving the physical cursor
  or stealing keyboard focus.

.DESCRIPTION
  Sends Win32 messages (WM_LBUTTONDOWN/UP, WM_CHAR, WM_KEYDOWN/UP) directly to
  the deepest child window under a point, so the target application receives the
  input while the user's own mouse stays exactly where it is.

  This is the "no mouse stealing" path. It only works on applications that
  handle standard window messages; self-drawn UIs (Electron/Chrome/Qt) often
  listen to raw input instead and will not react. The script reports what it
  did so the caller can fall back honestly rather than silently.

.PARAMETER Action
  click | type | key

.PARAMETER X / Y
  Absolute screen coordinates (for click).

.PARAMETER Text
  Text to type (for type). Sent as WM_CHAR, one message per character.

.PARAMETER Key
  Virtual-key code (for key), e.g. 13 for Enter.

.PARAMETER Title
  Target window title substring. Default: the foreground window.

.PARAMETER Hwnd
  Explicit target window handle; overrides -Title.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('click', 'type', 'key', 'probe')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = '',
  [int]$Key = 0,
  [string]$Title = '',
  [int]$Hwnd = 0
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# --- Win32 surface -----------------------------------------------------------
$src = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class BI {
  public delegate bool EnumCb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumCb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr RealChildWindowFromPoint(IntPtr p, POINT pt);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  // Timeout variant: SendMessageW blocks forever if the target window's message
  // loop is hung, which would wedge the whole call. SendMessageTimeout gives up
  // and lets us report it instead of stalling until the plugin timeout.
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(
    IntPtr h, uint m, IntPtr w, IntPtr l, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
  public const uint SMTO_ABORTIFHUNG = 0x0002;
  public const uint SMTO_NORMAL = 0x0000;
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static List<IntPtr> Windows = new List<IntPtr>();
  public static bool EnumCbImpl(IntPtr h, IntPtr l) {
    if (IsWindowVisible(h)) Windows.Add(h);
    return true;
  }
  // Read-only: list the visible child windows of a handle, for probing whether a
  // self-drawn app exposes real child HWNDs that can receive messages.
  public static List<IntPtr> Children(IntPtr parent) {
    Windows.Clear();
    EnumChildWindows(parent, new EnumCb(EnumCbImpl), IntPtr.Zero);
    return new List<IntPtr>(Windows);
  }
  public static IntPtr FindByTitle(string needle) {
    Windows.Clear();
    EnumWindows(new EnumCb(EnumCbImpl), IntPtr.Zero);
    foreach (IntPtr h in Windows) {
      int len = GetWindowTextLength(h);
      if (len <= 0) continue;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return h;
    }
    return IntPtr.Zero;
  }
  public static string ClassOf(IntPtr h) {
    var sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    return sb.ToString();
  }

  public static List<IntPtr> Descendants = new List<IntPtr>();
  public static bool EnumChildCb(IntPtr h, IntPtr l) {
    Descendants.Add(h);
    EnumChildWindows(h, new EnumCb(EnumChildCb), IntPtr.Zero);
    return true;
  }
  // Heuristic: the deepest descendant whose class looks like a text input.
  // RichEdit/Edit/NotepadTextBox cover classic Win32 and the new WinUI Notepad.
  public static IntPtr FindEditableDescendant(IntPtr root) {
    Descendants.Clear();
    EnumChildWindows(root, new EnumCb(EnumChildCb), IntPtr.Zero);
    for (int i = Descendants.Count - 1; i >= 0; i--) {
      string cls = ClassOf(Descendants[i]);
      if (cls.Contains("RichEdit") || cls.Contains("NotepadTextBox") || cls.Contains("TextBox") || cls.EndsWith("Edit")) return Descendants[i];
    }
    return IntPtr.Zero;
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop

function New-Point([int]$x, [int]$y) {
  $p = New-Object BI+POINT
  $p.X = $x; $p.Y = $y
  return $p
}

function Get-CursorPos {
  $p = New-Point 0 0
  [void][BI]::GetCursorPos([ref]$p)
  return $p
}

$result = [ordered]@{
  ok          = $false
  action      = $Action
  hwnd        = 0
  hwndClass   = $null
  childHwnd   = 0
  childClass  = $null
  cursorBefore = $null
  cursorAfter  = $null
  cursorMoved  = $false
  error       = $null
}

try {
  # 1. Resolve the target window.
  $target = [IntPtr]::Zero
  if ($Hwnd -ne 0) {
    $target = [IntPtr]$Hwnd
  } elseif ($Title -ne '') {
    $target = [BI]::FindByTitle($Title)
    if ($target -eq [IntPtr]::Zero) { throw "no visible window whose title contains '$Title'" }
  } else {
    $target = [BI]::GetForegroundWindow()
  }
  if ($target -eq [IntPtr]::Zero) { throw 'could not resolve a target window' }
  $result.hwnd = $target.ToInt64()
  $result.hwndClass = [BI]::ClassOf($target)

  # 1b. Probe mode: read-only. Enumerate the target's child windows and report
  # their classes plus whether the deepest child at a point is a self-drawn
  # surface. Sends NO messages, so it is safe to run against anything.
  if ($Action -eq 'probe') {
    $result.ok = $true
    $kids = [BI]::Children($target)
    $result.childCount = $kids.Count
    $result.children = @($kids | Select-Object -First 12 | ForEach-Object {
      @{ hwnd = $_.ToInt64(); class = [BI]::ClassOf($_) }
    })
    if ($X -ne 0 -or $Y -ne 0) {
      $pt = New-Object BI+POINT
      $pt.X = $X; $pt.Y = $Y
      $deep = [BI]::RealChildWindowFromPoint($target, $pt)
      $result.deepChildHwnd = $deep.ToInt64()
      $result.deepChildClass = [BI]::ClassOf($deep)
      $result.deepChildIsTopLevel = ($deep -eq $target)
    }
    $result.cursorBefore = $null
    $result | ConvertTo-Json -Compress -Depth 4
    exit 0
  }

  # 2. Remember where the user's cursor is, so we can prove we did not move it.
  $before = Get-CursorPos
  $result.cursorBefore = @($before.X, $before.Y)

  $child = [IntPtr]::Zero

  if ($Action -eq 'click') {
    # Map the screen point into the target's window coordinates, then ask
    # Windows for the deepest descendant at that spot. This works even when the
    # window is occluded, because we never hit-test the visible desktop.
    $wr = New-Object BI+RECT
    [void][BI]::GetWindowRect($target, [ref]$wr)
    $result.targetRect = @($wr.L, $wr.T, $wr.R, $wr.B)

    # Refuse a point outside the target window. Without this, the hit test
    # silently resolves to the top-level window and the click lands on the wrong
    # thing (or nowhere) while still reporting success.
    if ($X -lt $wr.L -or $X -gt $wr.R -or $Y -lt $wr.T -or $Y -gt $wr.B) {
      $result.ok = $false
      $result.error = "point $X,$Y is outside the target window rect ($($wr.L),$($wr.T),$($wr.R),$($wr.B)); no input was sent"
      return $result | ConvertTo-Json -Compress
    }

    $winPt = New-Point ($X - $wr.L) ($Y - $wr.T)
    $child = [BI]::RealChildWindowFromPoint($target, $winPt)
    if ($child -eq [IntPtr]::Zero) { $child = $target }

    # Coordinates for the message must be relative to the child's own client box.
    $cr = New-Object BI+RECT
    [void][BI]::GetWindowRect($child, [ref]$cr)
    $cx = $X - $cr.L
    $cy = $Y - $cr.T
    $lParam = [IntPtr]($cx -bor ($cy * 65536))

    # Send with a timeout: a hung target window would block SendMessageW forever.
    # 2000ms is plenty for a click; on timeout we report it rather than stalling.
    $r1 = [IntPtr]::Zero
    $r2 = [IntPtr]::Zero
    $sent1 = [BI]::SendMessageTimeout($child, 0x0201, [IntPtr]1, $lParam, [BI]::SMTO_ABORTIFHUNG, 2000, [ref]$r1)
    Start-Sleep -Milliseconds 30
    $sent2 = [BI]::SendMessageTimeout($child, 0x0202, [IntPtr]0, $lParam, [BI]::SMTO_ABORTIFHUNG, 2000, [ref]$r2)
    if (-not ($sent1 -and $sent2)) {
      throw "target window did not respond within 2s (it may be hung); no click was delivered"
    }
    $result.ok = $true
  }
  elseif ($Action -eq 'type') {
    # WM_CHAR must land on the control that owns the caret. A background window
    # has no focus, so we resolve the edit control the same way a click does:
    # map a point to the deepest child window. When no point is given, fall
    # back to the first plausible edit-class descendant of the target.
    if ($X -ne 0 -or $Y -ne 0) {
      $wr = New-Object BI+RECT
      [void][BI]::GetWindowRect($target, [ref]$wr)
      $winPt = New-Point ($X - $wr.L) ($Y - $wr.T)
      $child = [BI]::RealChildWindowFromPoint($target, $winPt)
      if ($child -eq [IntPtr]::Zero) { $child = $target }
    } else {
      $child = [BI]::FindEditableDescendant($target)
      if ($child -eq [IntPtr]::Zero) { $child = $target }
    }
    $failed = 0
    foreach ($ch in $Text.ToCharArray()) {
      $r = [IntPtr]::Zero
      $sent = [BI]::SendMessageTimeout($child, 0x0102, [IntPtr][int][char]$ch, [IntPtr]::Zero, [BI]::SMTO_ABORTIFHUNG, 2000, [ref]$r)  # WM_CHAR
      if (-not $sent) { $failed++ }
      Start-Sleep -Milliseconds 10
    }
    if ($failed -gt 0) {
      throw "$failed of $($Text.Length) characters were not delivered: the target window stopped responding"
    }
    $result.ok = $true
  }
  elseif ($Action -eq 'key') {
    $child = [BI]::GetForegroundWindow()
    if ($child -eq [IntPtr]::Zero) { $child = $target }
    $r1 = [IntPtr]::Zero
    $r2 = [IntPtr]::Zero
    $sent1 = [BI]::SendMessageTimeout($child, 0x0100, [IntPtr]$Key, [IntPtr]::Zero, [BI]::SMTO_ABORTIFHUNG, 2000, [ref]$r1)  # WM_KEYDOWN
    Start-Sleep -Milliseconds 20
    $sent2 = [BI]::SendMessageTimeout($child, 0x0101, [IntPtr]$Key, [IntPtr]::Zero, [BI]::SMTO_ABORTIFHUNG, 2000, [ref]$r2)  # WM_KEYUP
    if (-not ($sent1 -and $sent2)) {
      throw "target window did not respond within 2s (it may be hung); no key was delivered"
    }
    $result.ok = $true
  }

  $result.childHwnd = $child.ToInt64()
  $result.childClass = [BI]::ClassOf($child)
}
catch {
  $result.error = $_.Exception.Message
}
finally {
  $after = Get-CursorPos
  $result.cursorAfter = @($after.X, $after.Y)
  if ($null -ne $result.cursorBefore) {
    # cursorDisplaced = the position merely changed between the two reads. That
    # can happen because the user moved their mouse or another app did — it is
    # NOT evidence that this helper touched the cursor.
    $result.cursorDisplaced = -not (
      $result.cursorBefore[0] -eq $after.X -and $result.cursorBefore[1] -eq $after.Y
    )
  }
  # cursorMoved = this helper moved the cursor. It never does: input is delivered
  # purely as window messages, and there is no cursor-moving call in this script.
  # Kept as an explicit false so callers can assert the guarantee directly.
  $result.cursorMoved = $false
}

# Emit JSON only, so the plugin can parse stdout without scraping noise.
$result | ConvertTo-Json -Compress
