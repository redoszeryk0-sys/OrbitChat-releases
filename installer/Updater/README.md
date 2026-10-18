# Orbit Chat Updater

The standalone WPF updater is launched from the desktop app after a user chooses to update. It only installs a newer stable release with a matching Windows x64 portable ZIP, verifies the published SHA-256 digest, waits for Orbit Chat to exit, safely extracts to a staging directory, and replaces the app files. It keeps the existing app-data directory, installer helper, install marker, and Installed apps registration.

The updater shares the online installer's GitHub release catalog and ZIP download validation. Each portable release ZIP includes `Orbit-Chat-Updater.exe` next to `Orbit Chat.exe`. The app copies this bundled helper to the temporary directory and starts it with the temporary directory as its working directory; the updater also switches to the temporary directory on startup for older launchers. This prevents Windows from keeping the app's install folder locked during replacement. The updater retries transient file locks and offers retry or reopening the previous app if installation fails. Older installations without the bundled helper retain the GitHub-hosted updater fallback.

## Build

On Windows with the .NET 10 SDK:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/Updater/build-updater.ps1
```

This creates `release/Orbit-Chat-Updater.exe`.

## Legacy updater fallback

For older installed versions that do not include the updater in their portable folder, attach `Orbit-Chat-Updater.exe` to the existing non-versioned `Online_installer` release in `redoszeryk0-sys/OrbitChat-releases`. Keep that exact asset filename. The desktop app looks up the release asset through GitHub's API, requires a GitHub SHA-256 digest, downloads it over HTTPS, and verifies it before launching. New portable releases include the updater automatically when built with `npm run zip:portable`.

Versioned app releases remain separate and must include `Orbit-Chat-<version>-win-x64.zip`. The updater ignores drafts, pre-releases, and releases without a matching ZIP.
