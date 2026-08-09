[CmdletBinding()]
param(
    [string]$OutputDir = "",
    [string]$VarDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$crateRoot = [IO.Path]::GetFullPath((Join-Path $scriptRoot ".."))
$repoRoot = [IO.Path]::GetFullPath((Join-Path $crateRoot "..\.."))
$lockPath = Join-Path $crateRoot "wasm-build.lock.json"
$manifestPath = Join-Path $crateRoot "Cargo.toml"
$cargoLockPath = Join-Path $crateRoot "Cargo.lock"
$smokeScript = Join-Path $scriptRoot "smoke-web.mjs"

if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $crateRoot "dist\web"
}
if ([string]::IsNullOrWhiteSpace($VarDir)) {
    $VarDir = Join-Path $repoRoot "var\ck-build-core-wasm"
}
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$VarDir = [IO.Path]::GetFullPath($VarDir)

function Reset-WorkDirectory([string]$Path, [string]$AllowedRoot) {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullRoot = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd('\', '/')
    $prefix = $fullRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset path outside $fullRoot`: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
}

function Invoke-Checked([string]$Label, [string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Get-RelativeFileMap([string]$Root) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $result = [ordered]@{}
    Get-ChildItem -LiteralPath $rootPath -Recurse -File | Sort-Object FullName | ForEach-Object {
        $relative = $_.FullName.Substring($rootPath.Length).TrimStart('\', '/').Replace('\', '/')
        $result[$relative] = $_.FullName
    }
    return $result
}

$rustupExe = (Get-Command rustup -ErrorAction Stop).Source
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$tarExe = (Get-Command tar -ErrorAction Stop).Source
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
$toolchain = [string]$lock.rustToolchain
$target = [string]$lock.target
$bindgenVersion = [string]$lock.wasmBindgen.version
$hostTriple = "x86_64-pc-windows-msvc"
$hostProperty = $lock.wasmBindgen.hostArtifacts.PSObject.Properties[$hostTriple]
if ($null -eq $hostProperty) {
    throw "No wasm-bindgen artifact is locked for host $hostTriple"
}
$hostArtifact = $hostProperty.Value

$cargoLock = Get-Content -LiteralPath $cargoLockPath -Raw
$bindgenLockPattern = "name = `"wasm-bindgen`"\r?\nversion = `"$([regex]::Escape($bindgenVersion))`""
if ($cargoLock -notmatch $bindgenLockPattern) {
    throw "Cargo.lock does not pin wasm-bindgen $bindgenVersion"
}

New-Item -ItemType Directory -Path $VarDir -Force | Out-Null
$env:RUSTUP_HOME = Join-Path $VarDir "rustup"
$env:CARGO_HOME = Join-Path $VarDir "cargo"
$env:CARGO_TARGET_DIR = Join-Path $VarDir "target"
$env:TEMP = Join-Path $VarDir "tmp"
$env:TMP = $env:TEMP
$env:CARGO_INCREMENTAL = "0"
$env:SOURCE_DATE_EPOCH = "0"
New-Item -ItemType Directory -Path $env:RUSTUP_HOME, $env:CARGO_HOME, $env:CARGO_TARGET_DIR, $env:TEMP -Force | Out-Null

$installedToolchains = & $rustupExe toolchain list
if ($LASTEXITCODE -ne 0) {
    throw "rustup toolchain list failed"
}
if (-not ($installedToolchains | Where-Object { $_ -match "^$([regex]::Escape($toolchain))(\s|$)" })) {
    Invoke-Checked "rustup toolchain install" $rustupExe @(
        "toolchain", "install", $toolchain, "--profile", "minimal", "--target", $target, "--no-self-update"
    )
} else {
    $installedTargets = & $rustupExe target list --installed --toolchain $toolchain
    if ($LASTEXITCODE -ne 0) {
        throw "rustup target list failed"
    }
    if ($installedTargets -notcontains $target) {
        Invoke-Checked "rustup target add" $rustupExe @(
            "target", "add", $target, "--toolchain", $toolchain
        )
    }
}

$toolRoot = Join-Path $VarDir "tools\wasm-bindgen-$bindgenVersion-$hostTriple"
$bindgenExe = Join-Path $toolRoot "wasm-bindgen.exe"
$bindgenReady = Test-Path -LiteralPath $bindgenExe
if ($bindgenReady) {
    $versionOutput = & $bindgenExe --version
    $bindgenReady = $LASTEXITCODE -eq 0 -and $versionOutput -eq "wasm-bindgen $bindgenVersion"
}
if (-not $bindgenReady) {
    $downloadRoot = Join-Path $VarDir "downloads"
    $archivePath = Join-Path $downloadRoot "wasm-bindgen-$bindgenVersion-$hostTriple.tar.gz"
    $extractRoot = Join-Path $VarDir "extract\wasm-bindgen-$bindgenVersion-$hostTriple"
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    if (-not (Test-Path -LiteralPath $archivePath)) {
        Invoke-WebRequest -Uri ([string]$hostArtifact.url) -OutFile $archivePath
    }
    $archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($archiveHash -ne [string]$hostArtifact.sha256) {
        throw "wasm-bindgen archive SHA-256 mismatch: expected $($hostArtifact.sha256), got $archiveHash"
    }
    Reset-WorkDirectory $extractRoot $VarDir
    Invoke-Checked "extract wasm-bindgen" $tarExe @("-xzf", $archivePath, "-C", $extractRoot)
    $downloadedExe = Get-ChildItem -LiteralPath $extractRoot -Recurse -File -Filter "wasm-bindgen.exe" | Select-Object -First 1
    if ($null -eq $downloadedExe) {
        throw "wasm-bindgen.exe was not present in the locked release archive"
    }
    New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
    Copy-Item -LiteralPath $downloadedExe.FullName -Destination $bindgenExe -Force
    Reset-WorkDirectory $extractRoot $VarDir
}
$versionOutput = & $bindgenExe --version
if ($LASTEXITCODE -ne 0 -or $versionOutput -ne "wasm-bindgen $bindgenVersion") {
    throw "Expected wasm-bindgen $bindgenVersion, got $versionOutput"
}

Invoke-Checked "cargo wasm build" $rustupExe @(
    "run", $toolchain, "cargo", "build",
    "--manifest-path", $manifestPath,
    "--locked", "--release", "--lib", "--features", "wasm", "--target", $target
)
$rawWasm = Join-Path $env:CARGO_TARGET_DIR "$target\release\ck_build_core.wasm"
if (-not (Test-Path -LiteralPath $rawWasm)) {
    throw "Cargo did not produce $rawWasm"
}

$stageOne = Join-Path $VarDir "stage\web-one"
$stageTwo = Join-Path $VarDir "stage\web-two"
Reset-WorkDirectory $stageOne $VarDir
Reset-WorkDirectory $stageTwo $VarDir
$bindgenArguments = @($rawWasm, "--target", "web", "--out-name", "ck_build_core")
Invoke-Checked "wasm-bindgen first pass" $bindgenExe @($bindgenArguments + @("--out-dir", $stageOne))
Invoke-Checked "wasm-bindgen reproducibility pass" $bindgenExe @($bindgenArguments + @("--out-dir", $stageTwo))

$firstFiles = Get-RelativeFileMap $stageOne
$secondFiles = Get-RelativeFileMap $stageTwo
if (($firstFiles.Keys -join "`n") -ne ($secondFiles.Keys -join "`n")) {
    throw "wasm-bindgen emitted a different file set across identical passes"
}
foreach ($relative in $firstFiles.Keys) {
    $firstHash = (Get-FileHash -LiteralPath $firstFiles[$relative] -Algorithm SHA256).Hash
    $secondHash = (Get-FileHash -LiteralPath $secondFiles[$relative] -Algorithm SHA256).Hash
    if ($firstHash -ne $secondHash) {
        throw "Non-deterministic wasm-bindgen output: $relative"
    }
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
$records = @()
foreach ($relative in $firstFiles.Keys) {
    if ($relative.Contains("..")) {
        throw "Generated relative path is unsafe: $relative"
    }
    $destination = Join-Path $OutputDir $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-Item -LiteralPath $firstFiles[$relative] -Destination $destination -Force
    $file = Get-Item -LiteralPath $destination
    $records += [ordered]@{
        path = $relative
        bytes = $file.Length
        sha256 = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$buildManifest = [ordered]@{
    schemaVersion = 1
    rustToolchain = $toolchain
    target = $target
    wasmBindgen = $bindgenVersion
    files = $records
}
$manifestJson = ($buildManifest | ConvertTo-Json -Depth 5).Replace("`r`n", "`n")
$utf8NoBom = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutputDir "build-manifest.json"), $manifestJson + "`n", $utf8NoBom)

Invoke-Checked "browser binding smoke test" $nodeExe @($smokeScript, $OutputDir)

Reset-WorkDirectory $stageOne $VarDir
Reset-WorkDirectory $stageTwo $VarDir

Write-Host "CK Build Core browser WASM ready: $OutputDir"
$records | Format-Table path, bytes, sha256 -AutoSize
