param(
    [string]$PortableDirectory,
    [string]$OutputDirectory,
    [string]$Version
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json
$portableDirectory = if ([string]::IsNullOrWhiteSpace($PortableDirectory)) {
    Join-Path $repositoryRoot 'release\win-unpacked'
} else {
    [System.IO.Path]::GetFullPath($PortableDirectory)
}
$defaultReleaseDirectory = Join-Path (Split-Path -Parent $repositoryRoot) 'Orbit Chat Bundled Updater Builds'
$releaseDirectory = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $defaultReleaseDirectory
} else {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = $package.version }
$archivePath = Join-Path $releaseDirectory "Orbit-Chat-$Version-win-x64.zip"
$temporaryArchive = "$archivePath.new"
New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null

if (-not (Test-Path -LiteralPath (Join-Path $portableDirectory 'Orbit Chat.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $portableDirectory 'resources\app.asar') -PathType Leaf)) {
    throw "The portable Windows app is missing or incomplete at $portableDirectory. Run npm run build:portable first."
}
$updaterPath = Join-Path $releaseDirectory 'Orbit-Chat-Updater.exe'
$updaterBuildScript = Join-Path $repositoryRoot 'installer\Updater\build-updater.ps1'
& $updaterBuildScript -OutputDirectory $releaseDirectory
if ($LASTEXITCODE -ne 0) {
    throw "Building the bundled updater failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $updaterPath -PathType Leaf)) {
    throw "The updater build did not create $updaterPath"
}
Copy-Item -LiteralPath $updaterPath -Destination (Join-Path $portableDirectory 'Orbit-Chat-Updater.exe') -Force
if (Test-Path -LiteralPath (Join-Path $portableDirectory 'uninstall_orbitchat.exe')) {
    throw "The portable release ZIP must not contain the installer's uninstaller helper."
}

$payload = Get-ChildItem -LiteralPath $portableDirectory -Recurse -File
$payloadBytes = ($payload | Measure-Object -Property Length -Sum).Sum
if ($payload.Count -lt 70 -or $payloadBytes -lt 400MB) {
    throw "The portable app payload looks incomplete ($($payload.Count) files, $payloadBytes bytes)."
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $temporaryArchive) { Remove-Item -LiteralPath $temporaryArchive -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $portableDirectory,
    $temporaryArchive,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false)
Move-Item -LiteralPath $temporaryArchive -Destination $archivePath -Force

$zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = @($zip.Entries | ForEach-Object FullName)
    if ($names -notcontains 'Orbit Chat.exe' -or $names -notcontains 'resources/app.asar' -or
        $names -notcontains 'Orbit-Chat-Updater.exe' -or
        @($zip.Entries | Where-Object { $_.Name -match '^(uninstall_orbitchat|Orbit Chat Maintenance)\.exe$' }).Count -gt 0) {
        throw 'The completed ZIP failed its portable-app content check.'
    }
} finally {
    $zip.Dispose()
}

$artifact = Get-Item -LiteralPath $archivePath
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
Write-Host "Portable release ZIP ready: $($artifact.FullName)"
Write-Host "Size: $([math]::Round($artifact.Length / 1MB, 1)) MiB · $($payload.Count) app files"
Write-Host "SHA-256: $hash"
