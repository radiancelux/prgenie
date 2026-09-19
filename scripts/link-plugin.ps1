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
