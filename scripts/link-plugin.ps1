param(
  # Optional: quit Cursor before unlink. Off by default (too aggressive for dogfood).
  [switch]$ForceQuitCursor
)

$ErrorActionPreference = "Stop"
$src = (Resolve-Path (Join-Path $PSScriptRoot "..\packages\plugin")).Path
$destDir = Join-Path $env:USERPROFILE ".cursor\plugins\local"
$dest = Join-Path $destDir "prgenie"

function Test-IsWindowsHost {
  if ($null -ne (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue)) {
    return [bool]$IsWindows
  }
  return $env:OS -eq "Windows_NT"
}

function Test-IsFileLockError {
  param([System.Management.Automation.ErrorRecord]$ErrorRecord)
  $ex = $ErrorRecord.Exception
  while ($null -ne $ex) {
    if ($ex -is [System.IO.IOException]) { return $true }
    if ($ex.Message -match "being used by another process|cannot access the file|Access is denied") {
      return $true
    }
    $ex = $ex.InnerException
  }
  return $false
}

function Stop-PrgeniePluginHolders {
  param([string]$PluginDest)

  if (-not (Test-IsWindowsHost)) { return }

  $destNorm = $PluginDest.Replace("/", "\").TrimEnd("\").ToLowerInvariant()
  $localNeedle = "plugins\local\prgenie"
  $serverNeedle = (Join-Path $PluginDest "mcp\server.cjs").Replace("/", "\").ToLowerInvariant()

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = $_.CommandLine
    if ([string]::IsNullOrWhiteSpace($cmd)) { return }
    if ($_.ProcessId -eq $PID) { return }

    $cmdLower = $cmd.ToLowerInvariant()
    $matchesDest =
      $cmdLower.Contains($destNorm) -or
      $cmdLower.Contains($localNeedle) -or
      ($cmdLower.Contains("prgenie") -and $cmdLower.Contains("server.cjs")) -or
      $cmdLower.Contains($serverNeedle)

    if (-not $matchesDest) { return }

    # Targeted node / cmd wrappers only — never taskkill all node.exe.
    $name = [string]$_.Name
    if ($name -notmatch '^(node|node\.exe|cmd|cmd\.exe)$') { return }

    Write-Host "Stopping PID $($_.ProcessId) ($name) holding plugin folder..."
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Remove-PluginDest {
  param([string]$PluginDest)

  if (-not (Test-Path -LiteralPath $PluginDest)) { return }

  # Attempt 0: normal delete. On lock: kill holders, retry 1–2 times, then rename.
  $maxAttempts = 3
  for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
      Remove-Item -LiteralPath $PluginDest -Force -Recurse -ErrorAction Stop
      return
    } catch {
      if (-not (Test-IsFileLockError $_)) { throw }

      if ($attempt -lt $maxAttempts) {
        Write-Host "Plugin folder locked (attempt $attempt/$maxAttempts); stopping targeted prgenie holders..."
        Stop-PrgeniePluginHolders -PluginDest $PluginDest
        Start-Sleep -Milliseconds 750
        continue
      }

      $stamp = Get-Date -Format "yyyyMMddHHmmss"
      $oldName = "prgenie.old-$stamp"
      $oldPath = Join-Path (Split-Path -Parent $PluginDest) $oldName
      Write-Host ""
      Write-Host "Could not delete locked plugin folder (Windows still holds files)."
      Write-Host "Renaming to $oldName and installing into a fresh prgenie folder."
      Write-Host "Delete later (after quitting Cursor / MCP): $oldPath"
      Write-Host ""
      Rename-Item -LiteralPath $PluginDest -NewName $oldName
      return
    }
  }
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

if ($ForceQuitCursor -and (Test-IsWindowsHost)) {
  Write-Host "ForceQuitCursor: stopping Cursor processes..."
  Get-Process -Name "Cursor" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$requiredBundles = @(
  "packages\plugin\mcp\server.cjs",
  "packages\plugin\hooks\capture-subagent.cjs",
  "packages\plugin\hooks\github-gate.cjs",
  "packages\plugin\hooks\review-inbox.cjs"
)

Write-Host "Building plugin MCP/hook bundles (pnpm build)..."
Push-Location $repoRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    Write-Error "pnpm build failed with exit $LASTEXITCODE — cannot link plugin without generated bundles."
    exit 1
  }
} finally {
  Pop-Location
}

foreach ($rel in $requiredBundles) {
  $abs = Join-Path $repoRoot $rel
  if (-not (Test-Path -LiteralPath $abs)) {
    Write-Error "Missing generated bundle after build: $rel. Fix scripts/build.mjs or run pnpm build."
    exit 1
  }
}

# Cursor rejects junctions/symlinks whose target is outside ~/.cursor/plugins/local.
# Dest is a real copied directory, so always recurse-delete (rmdir fails on non-empty dirs).
Remove-PluginDest -PluginDest $dest

New-Item -ItemType Directory -Force -Path $dest | Out-Null
robocopy $src $dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) {
  Write-Error "robocopy failed with exit $LASTEXITCODE"
  exit 1
}

# Cursor does not expand ${PLUGIN_ROOT}. pin-plugin-mcp.mjs writes UTF-8 (no BOM),
# sets type=stdio, and pins command to this node.exe + absolute server.cjs.
# PowerShell Set-Content -Encoding utf8 writes a BOM that Cursor may fail to parse.
$pin = Join-Path $PSScriptRoot "pin-plugin-mcp.mjs"
& node $pin $dest
if ($LASTEXITCODE -ne 0) {
  Write-Error "pin-plugin-mcp.mjs failed with exit $LASTEXITCODE"
  exit 1
}

Write-Host "Installed Cursor plugin (real copy, not a junction):"
Write-Host "  $dest"
Write-Host "Reload is often not enough for MCP tools. In Customize → Plugins, disable and re-enable PR Genie."
Write-Host "Canonical MCP is this plugin (prgenie). Delete leftover .cursor/mcp.json if Connected MCPs shows two prgenie rows. See docs/troubleshooting.md."
