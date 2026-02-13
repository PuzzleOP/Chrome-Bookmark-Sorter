param(
  [string]$Selection,
  [ValidateSet("dry-run", "export-html", "apply")]
  [string]$Mode,
  [switch]$NoPause
)

$ErrorActionPreference = "Stop"

function Parse-JsonWithOptionalBom {
  param([string]$RawText)
  $cleaned = [string]$RawText
  if ($cleaned.Length -gt 0 -and [int][char]$cleaned[0] -eq 65279) {
    $cleaned = $cleaned.Substring(1)
  }
  return $cleaned | ConvertFrom-Json
}

function Get-BookmarksFilePath {
  param([string]$ProfileDirectory)
  $candidates = @("AccountBookmarks", "Bookmarks")
  foreach ($name in $candidates) {
    $candidatePath = Join-Path $ProfileDirectory $name
    if (Test-Path $candidatePath -PathType Leaf) {
      return $candidatePath
    }
  }
  return $null
}

function Resolve-SelectionNumbers {
  param(
    [string]$InputText,
    [int]$MaxValue
  )

  if ([string]::IsNullOrWhiteSpace($InputText)) {
    throw "Selection is empty."
  }

  $trimmed = $InputText.Trim()
  if ($trimmed -match "^(?i)all$") {
    return (1..$MaxValue)
  }

  $numbers = @()
  $parts = $trimmed -split "[,\s]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($part in $parts) {
    [int]$parsed = 0
    if (-not [int]::TryParse($part, [ref]$parsed)) {
      throw "Invalid selection '$part'. Use numbers like 1 or 1,3."
    }
    if ($parsed -lt 1 -or $parsed -gt $MaxValue) {
      throw "Selection '$parsed' is out of range (1-$MaxValue)."
    }
    if (-not ($numbers -contains $parsed)) {
      $numbers += $parsed
    }
  }

  return ($numbers | Sort-Object)
}

function Resolve-RunMode {
  param([string]$Value)

  if ($Value) {
    return $Value
  }

  Write-Host ""
  Write-Host "Choose run mode:"
  Write-Host "  [1] Dry run"
  Write-Host "  [2] Export sorted HTML (sync-safe recommended)"
  Write-Host "  [3] Direct apply to bookmarks file (advanced)"

  while ($true) {
    $inputMode = Read-Host "Enter 1, 2, or 3"
    if ($inputMode -eq "1") {
      return "dry-run"
    }
    if ($inputMode -eq "2") {
      return "export-html"
    }
    if ($inputMode -eq "3") {
      return "apply"
    }
    Write-Host "Invalid choice. Please enter 1, 2, or 3."
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$sorterScript = Join-Path $scriptDir "bookmark-sorter.js"
if (-not (Test-Path $sorterScript -PathType Leaf)) {
  throw "Missing file: $sorterScript"
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js was not found in PATH. Install Node.js 18+ first."
}

$chromeUserDataDir = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
if (-not (Test-Path $chromeUserDataDir -PathType Container)) {
  throw "Chrome user data directory not found: $chromeUserDataDir"
}

$localStatePath = Join-Path $chromeUserDataDir "Local State"
$profiles = @()

if (Test-Path $localStatePath -PathType Leaf) {
  $localStateRaw = Get-Content $localStatePath -Raw -Encoding UTF8
  $localState = Parse-JsonWithOptionalBom -RawText $localStateRaw
  $infoCache = $localState.profile.info_cache

  if ($infoCache) {
    foreach ($prop in $infoCache.PSObject.Properties) {
      $profileFolder = [string]$prop.Name
      $info = $prop.Value
      $profileDir = Join-Path $chromeUserDataDir $profileFolder
      if (-not (Test-Path $profileDir -PathType Container)) {
        continue
      }

      $bookmarksPath = Get-BookmarksFilePath -ProfileDirectory $profileDir
      if (-not $bookmarksPath) {
        continue
      }

      $displayName = [string]$info.name
      if ([string]::IsNullOrWhiteSpace($displayName)) {
        $displayName = $profileFolder
      }

      $email = [string]$info.user_name
      [double]$activeTime = 0
      if ($info.PSObject.Properties.Name -contains "active_time") {
        [void][double]::TryParse([string]$info.active_time, [ref]$activeTime)
      }

      $profiles += [pscustomobject]@{
        ProfileFolder = $profileFolder
        DisplayName = $displayName
        Email = $email
        ActiveTime = $activeTime
        BookmarksPath = $bookmarksPath
        BookmarksType = [System.IO.Path]::GetFileName($bookmarksPath)
      }
    }
  }
}

if ($profiles.Count -eq 0) {
  foreach ($dir in (Get-ChildItem $chromeUserDataDir -Directory -ErrorAction SilentlyContinue)) {
    $bookmarksPath = Get-BookmarksFilePath -ProfileDirectory $dir.FullName
    if (-not $bookmarksPath) {
      continue
    }
    $profiles += [pscustomobject]@{
      ProfileFolder = $dir.Name
      DisplayName = $dir.Name
      Email = ""
      ActiveTime = 0
      BookmarksPath = $bookmarksPath
      BookmarksType = [System.IO.Path]::GetFileName($bookmarksPath)
    }
  }
}

$profiles = $profiles | Sort-Object @{ Expression = "ActiveTime"; Descending = $true }, ProfileFolder

if ($profiles.Count -eq 0) {
  throw "No Chrome profiles with Bookmarks/AccountBookmarks files were found."
}

Write-Host ""
Write-Host "Detected Chrome profiles:"
for ($i = 0; $i -lt $profiles.Count; $i += 1) {
  $p = $profiles[$i]
  $emailPart = if ([string]::IsNullOrWhiteSpace($p.Email)) { "" } else { " - $($p.Email)" }
  $line = "[{0}] {1} ({2}){3} [{4}]" -f ($i + 1), $p.DisplayName, $p.ProfileFolder, $emailPart, $p.BookmarksType
  Write-Host "  $line"
}

$isInteractive = (-not $PSBoundParameters.ContainsKey("Selection")) -and (-not $PSBoundParameters.ContainsKey("Mode"))

if (-not $Selection) {
  Write-Host ""
  Write-Host "Choose profile number(s):"
  Write-Host "  Example: 1"
  Write-Host "  Example: 1,3"
  Write-Host "  Or type: all"
  $Selection = Read-Host "Selection"
}

$selectedNumbers = Resolve-SelectionNumbers -InputText $Selection -MaxValue $profiles.Count
$runMode = Resolve-RunMode -Value $Mode

if ($runMode -eq "apply") {
  $chromeProcess = Get-Process chrome -ErrorAction SilentlyContinue
  if ($chromeProcess) {
    Write-Host ""
    Write-Host "Chrome appears to be running. Close Chrome before applying changes." -ForegroundColor Yellow
    if ($isInteractive) {
      $confirm = Read-Host "Type YES to continue anyway"
      if ($confirm -ne "YES") {
        Write-Host "Cancelled."
        exit 1
      }
    } else {
      throw "Chrome is running. Close Chrome and retry."
    }
  }
}

$anyFailed = $false

foreach ($selected in $selectedNumbers) {
  $profile = $profiles[$selected - 1]
  $safeProfileFolder = ($profile.ProfileFolder -replace "[^A-Za-z0-9._-]", "_")
  $backupDir = Join-Path (Join-Path $scriptDir "backups") $safeProfileFolder
  $exportsDir = Join-Path $scriptDir "exports"
  if (-not (Test-Path $exportsDir)) {
    New-Item -ItemType Directory -Path $exportsDir | Out-Null
  }
  $exportPath = Join-Path $exportsDir ("sorted-{0}.html" -f $safeProfileFolder)

  Write-Host ""
  Write-Host ("=== {0} ({1}) ===" -f $profile.DisplayName, $profile.ProfileFolder)

  $args = @(
    $sorterScript,
    "--profile", $profile.ProfileFolder,
    "--backup-dir", $backupDir
  )

  if ($runMode -eq "apply") {
    $args += "--apply"
    if ($profile.BookmarksType -eq "AccountBookmarks") {
      Write-Host "Warning: direct apply to AccountBookmarks can be reverted by Chrome account sync." -ForegroundColor Yellow
      if ($isInteractive) {
        $confirmAccountApply = Read-Host "Type YES to continue direct apply for this profile"
        if ($confirmAccountApply -ne "YES") {
          Write-Host "Skipped."
          continue
        }
      }
      $args += "--allow-account-apply"
    }
  } elseif ($runMode -eq "export-html") {
    $args += @("--dry-run", "--export-html", $exportPath)
    Write-Host ("Export file: {0}" -f $exportPath)
  } else {
    $args += "--dry-run"
  }

  & node @args
  if ($LASTEXITCODE -ne 0) {
    $anyFailed = $true
    Write-Host ("Sort failed for profile {0}." -f $profile.ProfileFolder) -ForegroundColor Red
  }
}

Write-Host ""
if ($anyFailed) {
  Write-Host "Completed with errors." -ForegroundColor Red
  exit 1
}

Write-Host "Completed successfully."

if ($isInteractive -and -not $NoPause) {
  Write-Host ""
  [void](Read-Host "Press Enter to exit")
}
