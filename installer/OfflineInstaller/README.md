# Orbit Chat online installer

This WPF setup wizard looks up Orbit Chat GitHub releases, selects the highest semantic version by default, downloads the matching Windows x64 portable ZIP, verifies GitHub's SHA-256 digest when available, and installs the extracted app.

## Release asset convention

Publish a release in `redoszeryk0-sys/OrbitChat-releases` with a semantic version tag (for example, `1.2.0`) and attach a portable ZIP named:

```text
Orbit-Chat-<tag>-win-x64.zip
```

The ZIP must contain `Orbit Chat.exe` and `resources/app.asar` at its root. Do not include `uninstall_orbitchat.exe`; setup copies its own signed-off uninstaller helper into the chosen install folder.

The installer reads the GitHub releases API (including each release's tag and assets). Draft releases and tags without a matching Windows ZIP are omitted. Semantic versions sort numerically; the highest version is selected and marked **latest**.

## Build

With the .NET 10 SDK installed, run from any folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<project>\build-online-installer.ps1"
```

Replace `<project>` with this `OfflineInstaller` source directory. The self-contained x64 online installer is written to:

```text
<repository>\release\Orbit-Chat-Online-Installer.exe
```

The setup executable is also copied into the selected app directory as `uninstall_orbitchat.exe`. The uninstaller is registered under the current Windows user in Installed apps, removes only a marked Orbit Chat installation and its shortcuts, and keeps account data and settings.

## Installation behavior

- Offers a per-user installation directory, defaulting to `%LOCALAPPDATA%\Programs\Orbit Chat`.
- Updates a prior Orbit Chat install registered by the older custom installer, or an extracted portable folder identified by its Orbit Chat executable metadata and `resources/app.asar`.
- When Browse selects a parent folder, creates an `Orbit Chat` subfolder; selecting an existing Orbit Chat folder updates it in place.
- Downloads the selected release over HTTPS with progress, verifies the advertised size and SHA-256 digest, and safely rejects ZIP path traversal and symbolic links.
- Extracts to a staging directory, validates the portable app structure, then moves it into place.
- Refuses to replace non-Orbit Chat files in a non-empty destination.
- Creates Desktop and Start-menu shortcuts and registers the chosen version in Windows Installed apps.
- Does not remove Electron user data during updates or uninstall.

The existing `register-existing-dev-install.ps1` remains a separate migration helper for legacy OrbitChat Dev installations.
