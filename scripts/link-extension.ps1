$ErrorActionPreference = "Stop"
$src = (Resolve-Path (Join-Path $PSScriptRoot "..\packages\extension")).Path
$dist = Join-Path $src "dist\extension.js"
if (-not (Test-Path $dist)) {
  Write-Error "Missing $dist. Run pnpm build first."
  exit 1
}

$destDir = Join-Path $env:USERPROFILE ".cursor\extensions"
$pkg = Get-Content -LiteralPath (Join-Path $src "package.json") -Raw | ConvertFrom-Json
$folder = "prgenie.$($pkg.name)-$($pkg.version)"
$dest = Join-Path $destDir $folder

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
if (Test-Path $dest) {
  Remove-Item -LiteralPath $dest -Force -Recurse
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null

Copy-Item -LiteralPath (Join-Path $src "package.json") -Destination $dest
New-Item -ItemType Directory -Force -Path (Join-Path $dest "dist") | Out-Null
Copy-Item -LiteralPath $dist -Destination (Join-Path $dest "dist\extension.js")
$media = Join-Path $src "media"
if (Test-Path $media) {
  Copy-Item -LiteralPath $media -Destination (Join-Path $dest "media") -Recurse
}

# Drop older local installs so this window does not keep the stale 0.1.0 panel.
Get-ChildItem -LiteralPath $destDir -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "prgenie.prgenie-*" -and $_.FullName -ne $dest } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -Recurse }

Write-Host "Installed PR Genie sidebar extension:"
Write-Host "  $dest"
Write-Host "Reload the window (or quit Cursor fully and reopen) to pick up Local PRs / Export."
