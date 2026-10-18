# Orbit Chat installer UI prototype

This folder contains an earlier standalone visual prototype only. The functional online setup wizard is now in [`OfflineInstaller`](OfflineInstaller/README.md) (the folder name is retained for compatibility); it downloads and installs portable GitHub releases. This prototype still uses fixed sample versions and simulated progress.

## Version selector demo

- The selector defaults to `1.2.0`, the newest version currently defined in the preview.
- The Welcome screen explains that a functioning installer will automatically detect Orbit Chat; it has no version selector.
- The one release selector lives on the Options step and defaults to the newest sample release, `1.2.0`.
- This preview simulates no existing installation, so it displays **Install**. The underlying comparison logic uses **Fix** for an exact version match, **Upgrade** if the selected release is newer, and **Downgrade** if it is older. There is no user-facing installed-version picker.
- The release selector is a custom rounded, dark Orbit Chat-style dropdown with a lavender **Newest** badge.
- The selectable versions and no-install detection are samples, not a release feed or real app scan. Nothing is downloaded or installed.

## Notice

The Notice step displays the text in the repository's existing `LICENSE`. That file is a project notice, not a complete EULA or privacy policy; the preview doesn't invent additional policies.

## Safety and next steps

**This prototype is only a visual preview.** The progress page is timed animation, and its completion screen is simulated. It never writes installation files, modifies app data, registers shortcuts, or changes system state. Use the functional online installer documented in [`OfflineInstaller/README.md`](OfflineInstaller/README.md) for real installs.

The prototype is not used by the functional installer and may be kept as a design reference. The functional installer performs its own GitHub release lookup, checksum validation, extraction, shortcut setup, and registered uninstall flow.

## Run the preview

From the repository root on Windows with the .NET 10 SDK and Windows Desktop runtime, run:

```powershell
dotnet run --project installer/OrbitChat.SetupPreview.csproj
```
