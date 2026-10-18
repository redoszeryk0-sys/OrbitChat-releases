# Orbit Chat

Orbit Chat is an independent Windows communication app with an embedded Node.js backend. It uses Electron, React, TypeScript, Express, Socket.IO, and SQLite (through SQL.js). It is not affiliated with Discord.

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

## Data locations

The installed desktop app stores its database, attachments, settings, and encrypted session tokens in Electron's per-user application data directory. Back up the whole data directory to preserve the SQLite database and uploaded files.
