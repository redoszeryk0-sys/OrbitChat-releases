# Orbit Chat

Orbit Chat is an independent Windows communication app with a self-hostable Node.js backend. It uses Electron, React, TypeScript, Express, Socket.IO, and SQLite (through SQL.js). It is not affiliated with Discord.

## What works

- Local account registration and sign-in, hashed passwords, expiring sessions, and encrypted desktop session-token storage when Windows secure storage is available.
- Server creation and invitation links, membership and owner/admin checks, text/announcement/voice channels, member lists, and presence while connected.
- Persistent channel and friend direct messages, real-time delivery, editing, soft deletion, replies, reactions, and report submission.
- Authenticated file uploads/downloads for arbitrary file types (up to 20 GB per file/upload), Markdown, safe previews for common image types, emoji reactions, Unicode stickers, and optional Tenor GIF search.
- @mentions by server-member username or display name, autocomplete, highlighted message tags, and direct mention notifications.
- Disk-streamed, resumable file attachments up to 20 GB per upload. Arbitrary bytes are preserved and downloaded as attachments; untrusted file types are not rendered inline.
- JPEG/PNG/GIF avatar editor with a zoomable circular preview, server-backed avatar history, restore, and per-device local backups.
- Peer-to-peer audio voice channels using WebRTC; an HTTPS TURN service is needed for reliable connections across restrictive networks.
- Dark/light/system appearance, text size, reduced motion, sidebar preference, profile/status, and desktop notifications.
- GitHub stable-release checks with an update notification and a separate, user-confirmed updater wizard.
- A Windows NSIS Setup Wizard installer.
- Orbit-themed Windows setup wizard with current-user/all-user scope, install location, repair/upgrade/downgrade choices, and an animated installation status page.

See [the feature checklist](docs/FEATURE_CHECKLIST.md) for tested, partial, and unavailable features. Orbit Chat is still an early core and does not implement every feature in the project brief.

## Install

Run `release\Orbit-Chat-Online-Installer.exe` (or download it from the installer release), choose a version and install location, and launch Orbit Chat from Start or the desktop shortcut. Setup reads the versioned portable ZIP assets from the public [`OrbitChat-releases`](https://github.com/redoszeryk0-sys/OrbitChat-releases) repository, verifies the published digest when available, and registers an uninstaller in Windows Installed apps. The installer is per-user; account data and settings are kept when updating or uninstalling.

This unsigned build may show a Windows SmartScreen prompt. Orbit Chat has not been code-signed.

## Run from source

Requirements: Windows 10/11 x64, Node.js 22 or newer, and npm.

```powershell
npm install
npm run dev
```

Build and test:

```powershell
npm run typecheck
npm test
npm run build
npm run build:portable
npm run zip:portable
npm run installer:online
npm run installer:updater
```

`build:portable` prepares the Windows x64 app folder, and `zip:portable` builds the updater and includes it in the versioned portable ZIP automatically. By default, the ZIP is written to the sibling `Orbit Chat Bundled Updater Builds` folder; pass `-OutputDirectory` to `scripts/build-portable-zip.ps1` to choose another location. Versioned app assets use the filename form `Orbit-Chat-<tag>-win-x64.zip`. Older installed versions can still use the updater attached to the `Online_installer` release in `OrbitChat-releases`. See [`installer/OfflineInstaller/README.md`](installer/OfflineInstaller/README.md) and [`installer/Updater/README.md`](installer/Updater/README.md) for release conventions and behavior. See [backend self-hosting](docs/SELF_HOSTING.md) and [backup and restore](docs/BACKUP_RESTORE.md).

To build and publish versioned portable releases automatically from GitHub Actions, see [automatic releases](docs/AUTOMATIC_RELEASES.md).

## Host the API on Debian

From the project folder, run `bash scripts/orbitchat-server.sh install`. On first run it asks for a local API port, installs only the API runtime dependencies, and starts the text-only service manager over HTTP. Use its `start`, `stop`, `restart`, `status`, `logs`, and `configure-playit` actions to manage it. See [the Debian and Playit setup](docs/SELF_HOSTING.md) for LAN firewall steps and TCP tunnel configuration.

## Optional services

- **Tenor:** Set `TENOR_API_KEY` on the backend to enable GIF search. Without it, the app reports that GIF search is not configured and sends no placeholder results. See [Tenor's API documentation](https://developers.google.com/tenor/guides/endpoints).
- **TURN:** Set `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL` to your own authenticated TURN service for better voice connectivity. Do not put secrets in the desktop renderer or commit them.
- **Playit.gg:** A TCP tunnel can expose the HTTP API without asking friends to install the agent. Configure the agent's local target to the API port and use Playit's separate public host and port in Orbit Chat. The server status screen and `status` command check the agent process and public `/health` route.

No third-party service is required for local accounts, text chat, friends, uploads, or local SQLite storage.

## Data locations

The installed desktop app stores its database, attachments, settings, and encrypted session tokens in Electron's per-user application data directory. The backend hosting guide explains the standalone server's `DATA_DIR` and `UPLOAD_DIR` locations. Back up both the SQLite database and uploaded files.
