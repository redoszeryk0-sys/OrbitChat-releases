$ErrorActionPreference = 'Stop'

$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs\OrbitChat-Dev'
$executableName = 'OrbitChat Dev.exe'
$executablePath = Join-Path $installDirectory $executableName
$maintenanceSource = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'release\Orbit-Chat-Online-Installer.exe'
$maintenanceName = 'uninstall_orbitchat.exe'
$maintenancePath = Join-Path $installDirectory $maintenanceName
$uninstallKeyName = 'OrbitChatDev.LegacyInstall'
$registryPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$uninstallKeyName"

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "The existing OrbitChat Dev executable was not found at $executablePath. Nothing was changed."
}
if (-not (Test-Path -LiteralPath (Join-Path $installDirectory 'resources\app.asar') -PathType Leaf)) {
    throw "The existing OrbitChat Dev app package was not found. Nothing was changed."
}
if (-not (Test-Path -LiteralPath $maintenanceSource -PathType Leaf)) {
    throw "The online installer was not built at $maintenanceSource. Run build-online-installer.ps1 first."
}

if (Test-Path -LiteralPath $registryPath) {
    $existing = Get-ItemProperty -LiteralPath $registryPath
    if ($existing.DisplayName -ne 'OrbitChat Dev' -or
        -not [string]::Equals($existing.InstallLocation, $installDirectory, [StringComparison]::OrdinalIgnoreCase)) {
        throw "An unrelated uninstall entry already exists at $registryPath. Nothing was overwritten."
    }
}

Copy-Item -LiteralPath $maintenanceSource -Destination $maintenancePath -Force
$version = (Get-Item -LiteralPath $executablePath).VersionInfo.ProductVersion
$uninstallCommand = "`"$maintenancePath`" --uninstall --product-name `"OrbitChat Dev`" " +
    "--install-directory `"$installDirectory`" --install-folder `"OrbitChat-Dev`" " +
    "--app-executable `"OrbitChat Dev.exe`" --registry-key `"$uninstallKeyName`" " +
    "--start-menu-folder `"OrbitChat Dev`" --shortcut-name `"OrbitChat Dev.lnk`" --version `"$version`""

New-Item -Path $registryPath -Force | Out-Null
New-ItemProperty -Path $registryPath -Name DisplayName -Value 'OrbitChat Dev' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name DisplayVersion -Value $version -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name Publisher -Value 'Orbit Chat' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name InstallLocation -Value $installDirectory -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name DisplayIcon -Value "`"$executablePath`",0" -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name UninstallString -Value $uninstallCommand -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name QuietUninstallString -Value $uninstallCommand -PropertyType String -Force | Out-Null
New-ItemProperty -Path $registryPath -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $registryPath -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $registryPath -Name InstallDate -Value (Get-Date -Format 'yyyyMMdd') -PropertyType String -Force | Out-Null

Remove-Item -LiteralPath (Join-Path $installDirectory 'Uninstall-Orbit-Chat.ps1') -Force -ErrorAction SilentlyContinue
"Registered OrbitChat Dev with the matching custom uninstaller: $maintenancePath"
