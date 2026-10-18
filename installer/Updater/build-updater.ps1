param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $projectDirectory 'OrbitChat.Updater.csproj'
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $projectDirectory)
$releaseDirectory = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    Join-Path $repositoryRoot 'release'
} else {
    [System.IO.Path]::GetFullPath($OutputDirectory)
}
$updaterFile = Join-Path $releaseDirectory 'Orbit-Chat-Updater.exe'
$publishedFile = Join-Path $projectDirectory 'bin\Release\net10.0-windows\win-x64\publish\Orbit-Chat-Updater.exe'

Write-Host 'Publishing the self-contained Orbit Chat updater...'
& dotnet publish $projectFile --configuration Release --verbosity minimal -p:UseAppHost=true -p:RestoreIgnoreFailedSources=true
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $publishedFile)) {
    throw "The updater was not created at $publishedFile"
}

New-Item -ItemType Directory -Path $releaseDirectory -Force | Out-Null
$temporaryFile = "$updaterFile.new"
Copy-Item -LiteralPath $publishedFile -Destination $temporaryFile -Force
Move-Item -LiteralPath $temporaryFile -Destination $updaterFile -Force
$artifact = Get-Item -LiteralPath $updaterFile
$hash = (Get-FileHash -LiteralPath $updaterFile -Algorithm SHA256).Hash
Write-Host "Updater ready: $($artifact.FullName)"
Write-Host "Size: $([math]::Round($artifact.Length / 1MB, 1)) MiB"
Write-Host "SHA-256: $hash"
