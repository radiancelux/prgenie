$ErrorActionPreference = "Stop"
$src = (Resolve-Path (Join-Path $PSScriptRoot "..\packages\plugin")).Path
$destDir = Join-Path $env:USERPROFILE ".cursor\plugins\local"
$dest = Join-Path $destDir "prgenie"

New-Item -ItemType Directory -Force -Path $destDir | Out-Null

# Cursor rejects junctions/symlinks whose target is outside ~/.cursor/plugins/local.
# Dest is a real copied directory, so always recurse-delete (rmdir fails on non-empty dirs).
if (Test-Path $dest) {
  Remove-Item -LiteralPath $dest -Force -Recurse
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null
robocopy $src $dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
if ($LASTEXITCODE -ge 8) {
  Write-Error "robocopy failed with exit $LASTEXITCODE"
  exit 1
}

# Cursor resolves plugin mcp.json relative paths against the workspace, not the plugin
# folder. Pin the copied config to this install so Local MCP can spawn.
$server = (Join-Path $dest "mcp\server.cjs").Replace("\", "/")
$mcpPath = Join-Path $dest "mcp.json"
$mcp = Get-Content -LiteralPath $mcpPath -Raw
$mcp = $mcp -replace '\$\{PLUGIN_ROOT\}/mcp/server\.cjs', $server
Set-Content -LiteralPath $mcpPath -Value $mcp.TrimEnd() -Encoding utf8

Write-Host "Installed Cursor plugin (real copy, not a junction):"
Write-Host "  $dest"
Write-Host "Reload the window, then in Customize open Plugins and look for PR Genie."
