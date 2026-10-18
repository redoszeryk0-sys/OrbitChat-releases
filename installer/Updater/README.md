# Orbit Chat Updater

The standalone WPF updater is launched from the desktop app after a user chooses to update. It only installs a newer stable release with a matching Windows x64 portable ZIP, verifies the published SHA-256 digest, waits for Orbit Chat to exit, safely extracts to a staging directory, and replaces the app files. It keeps the existing app-data directory, installer helper, install marker, and Installed apps registration.

The updater shares the online installer's GitHub release catalog and ZIP download validation. Each portable release ZIP includes `Orbit-Chat-Updater.exe` next to `Orbit Chat.exe`. The app copies this bundled helper to the temporary directory and starts it with the temporary directory as its working directory; the updater also switches to the temporary directory on startup. This prevents Windows from keeping the app's install folder locked during replacement. The updater retries transient file locks and offers retry or reopening the previous app if installation fails. The updater is bundled with each app release and is not published as a separate release asset.

## Build

On Windows with the .NET 10 SDK:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/Updater/build-updater.ps1
```

This creates a standalone `release/Orbit-Chat-Updater.exe` for local testing. Portable release packaging builds the helper in a temporary folder and includes it inside the portable ZIP.

Older installed versions without a bundled updater should be installed using the current Online Installer. The Online Installer fetches the current versioned portable release, whose files include the updater.

Versioned app releases remain separate and must include `Orbit-Chat-<version>-win-x64.zip`. The updater ignores drafts, pre-releases, and releases without a matching ZIP.
