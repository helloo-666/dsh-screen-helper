<#
.SYNOPSIS
  Install dsh-screen-helper into the desktop profile and write its config.
.DESCRIPTION
  Downloads the release tarball, runs `dsh plugin add`, then ensures the profile's
  cordis.patch.yml has a screen-helper row with cliPath and approval set. Safe to
  re-run: existing config values are left alone.
.PARAMETER CliPath
  Absolute path to ScreenAutomationHelper.exe. Defaults to the common install dir.
.PARAMETER Approval
  One of always / mutating / never. Defaults to always.
.PARAMETER Profile
  dsh profile name. Defaults to desktop.
.PARAMETER Version
  Release tag to fetch. Defaults to v0.1.0.
.EXAMPLE
  .\install.ps1 -CliPath 'D:\ScreenAutomationHelper\ScreenAutomationHelper.exe' -Approval mutating
#>
[CmdletBinding()]
param(
  [string] $CliPath = 'D:\ScreenAutomationHelper\ScreenAutomationHelper.exe',
  [ValidateSet('always', 'mutating', 'never')]
  [string] $Approval = 'always',
  [string] $Profile = 'desktop',
  [string] $Version = 'v0.1.0'
)

$ErrorActionPreference = 'Stop'

$repo = 'helloo-666/dsh-screen-helper'
$tarName = 'dsh-screen-helper-0.1.0.tgz'
$releaseUrl = "https://github.com/$repo/releases/download/$Version/$tarName"

# 1. Resolve the dsh executable (avoid any PowerShell git/gh wrapper).
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { throw 'dsh CLI not found on PATH. Install DeepSeek Harness first.' }
$dshExe = $dsh.Source

# 2. Download the tarball to a temp location.
$tmp = Join-Path $env:TEMP "dsh-screen-helper-$Version.tgz"
Write-Host "==> downloading $releaseUrl"
try {
  Invoke-WebRequest -Uri $releaseUrl -OutFile $tmp -UseBasicParsing -ErrorAction Stop
} catch {
  throw "download failed: $_`nFetch $tarName from the GitHub Release manually, then run install.ps1 with -TarballPath."
}
Write-Host "    saved to $tmp"

# 3. Install the plugin via dsh. Run through cmd /c so we bypass any PowerShell
#    function wrapper that intercepts dsh's own argument parsing.
Write-Host "==> dsh plugin --profile $Profile add $tmp"
$addOut = cmd /c "`"$dshExe`" plugin --profile $Profile add `"$tmp`"" 2>&1
$addOut | ForEach-Object { Write-Host "    $_" }

# 4. Locate the profile's cordis.patch.yml and upsert the screen-helper row.
$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$patchPath = Join-Path $homeDir "profiles\$Profile\cordis.patch.yml"
Write-Host "==> config $patchPath"

if (-not (Test-Path $patchPath)) {
  $yaml = @"
# dsh-screen-helper install ($Version)
# cliPath points at the ScreenAutomationHelper executable.
- id: screen-helper
  config:
    cliPath: '$CliPath'
    timeoutMs: 60000
    approval: $Approval
    blockDestructive: false
"@
  Set-Content -Path $patchPath -Value $yaml -Encoding UTF8
  Write-Host '    created cordis.patch.yml with the screen-helper row'
} else {
  $text = Get-Content $patchPath -Raw -Encoding UTF8
  if ($text -match 'id:\s*screen-helper') {
    Write-Host '    screen-helper row already present; leaving it untouched'
  } else {
    $append = @"

- id: screen-helper
  config:
    cliPath: '$CliPath'
    timeoutMs: 60000
    approval: $Approval
    blockDestructive: false
"@
    Add-Content -Path $patchPath -Value $append -Encoding UTF8
    Write-Host '    appended screen-helper row'
  }
}

Write-Host ''
Write-Host 'Done. Restart the profile (or wait for HMR) and the screen_automation tool is available.'
Write-Host "Verify: dsh --profile $Profile --dump-config | Select-String screen-helper"
