$ErrorActionPreference = 'Stop'

$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectFile = Join-Path $projectDirectory 'OrbitChat.OnlineInstaller.csproj'
$outputDirectory = Join-Path (Split-Path -Parent (Split-Path -Parent $projectDirectory)) 'release'
$installerFile = Join-Path $outputDirectory 'Orbit-Chat-Online-Installer.exe'
$publishedFile = Join-Path $projectDirectory 'bin\Release\net10.0-windows\win-x64\publish\OrbitChat.OnlineInstaller.exe'

Write-Host 'Publishing the Orbit Chat online installer and its embedded uninstaller UI...'
& dotnet clean $projectFile --configuration Release --verbosity quiet
if ($LASTEXITCODE -ne 0) {
    throw "dotnet clean failed with exit code $LASTEXITCODE"
}
& dotnet publish $projectFile --configuration Release --verbosity minimal -p:UseAppHost=true -p:RestoreIgnoreFailedSources=true -p:MaintenanceBuild=false -p:IncludeAppPayload=false
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $publishedFile)) {
    throw "The online installer was not created at $publishedFile"
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$temporaryInstallerFile = "$installerFile.new"
Copy-Item -LiteralPath $publishedFile -Destination $temporaryInstallerFile -Force
Move-Item -LiteralPath $temporaryInstallerFile -Destination $installerFile -Force
$artifact = Get-Item -LiteralPath $installerFile
$sha256 = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($installerFile)
try {
    $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '')
} finally {
    $stream.Dispose()
    $sha256.Dispose()
}
Write-Host "Online installer ready: $($artifact.FullName)"
Write-Host "Size: $([math]::Round($artifact.Length / 1MB, 1)) MiB"
Write-Host "SHA-256: $hash"
