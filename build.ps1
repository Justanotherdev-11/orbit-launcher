# Builds "Orbit Launcher.exe" next to this script. Works on any PC with Rust installed.
# Build files go to %LOCALAPPDATA% so cloud-synced folders (OneDrive, Dropbox) stay small.
#   .\build.ps1          optimized build
#   .\build.ps1 -Debug   dev build (DevTools on localhost:9333)
param([switch]$Debug)
$ErrorActionPreference = 'Stop'

$env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'OrbitLauncherBuild\target'
$cargo = (Get-Command cargo -ErrorAction SilentlyContinue).Source
if (-not $cargo) {
    $cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (-not (Test-Path $cargo)) {
        Write-Host "Rust isn't installed. Install it from https://rustup.rs (plus the Visual Studio C++ Build Tools), then run this again."
        exit 1
    }
}

Push-Location (Join-Path $PSScriptRoot 'src-tauri')
try {
    if ($Debug) { & $cargo build } else { & $cargo build --release }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

$kind = if ($Debug) { 'debug' } else { 'release' }
$out = Join-Path $PSScriptRoot 'Orbit Launcher.exe'
Copy-Item (Join-Path $env:CARGO_TARGET_DIR "$kind\orbit-launcher.exe") $out -Force
Write-Host "Built $out"
