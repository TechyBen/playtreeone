# Builds the treeps1 screensaver into %LOCALAPPDATA%\treeps1\saver.
# Afterwards: right-click treeps1.scr > Install (Explorer opens on it).
param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $env:LOCALAPPDATA 'treeps1\saver'

dotnet publish (Join-Path $PSScriptRoot 'treeps1saver.csproj') -c Release -r win-x64 --self-contained false -o $out
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

# A screensaver is an .exe with a .scr extension.
Copy-Item (Join-Path $out 'treeps1.exe') (Join-Path $out 'treeps1.scr') -Force

# Copy the web page next to it.
$web = Join-Path $out 'web'
if (Test-Path $web) { Remove-Item $web -Recurse -Force }
New-Item -ItemType Directory $web | Out-Null
Copy-Item (Join-Path $root 'index.html') $web
Copy-Item (Join-Path $root 'src') $web -Recurse

Write-Host "Built $out\treeps1.scr"
Write-Host 'Right-click it and choose Install, then pick a wait time in Screen Saver Settings.'
if (-not $NoOpen) { explorer.exe "/select,$out\treeps1.scr" }
