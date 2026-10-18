# Orbit Chat

Orbit Chat is an independent Windows desktop chat application built with Electron, React, and TypeScript. Its application backend uses Express, Socket.IO, and SQLite (SQL.js).

This project was developed with substantial assistance from AI tools (“vibe coding”). AI tools helped generate and modify code; the project is directed and maintained by its creator.

## Download

Official Windows releases and the online installer are available from the [OrbitChat-releases GitHub Releases page](https://github.com/redoszeryk0-sys/OrbitChat-releases/releases).

## Development

Requirements: Windows 10/11 x64, Node.js 22 or newer, and npm.

```powershell
npm install
npm run dev
```

Useful checks and builds:

```powershell
npm run typecheck
npm test
npm run build
npm run build:portable
npm run installer:online
```

The desktop app includes its server application code under `server/src`; this source repository also includes the standalone Debian server manager and its hosting documentation.

## Project files

- `src/` — Electron desktop application and renderer
- `server/src/` — API/server code used by the application
- `tests/`, `server/test/` — automated tests
- `installer/OfflineInstaller/` - Windows online installer and uninstaller source
- `installer/Updater/` - standalone, bundled app updater source
- `scripts/`, `server-config/`, `docs/` - Debian server management, configuration examples, and hosting/backup guides
- `build/` - Windows app and installer artwork/configuration

## Automatic releases

Versioned portable ZIP releases are built and published by GitHub Actions when a matching semantic-version tag is pushed. See [`docs/AUTOMATIC_RELEASES.md`](docs/AUTOMATIC_RELEASES.md) for the required `ORBITCHAT_RELEASES_TOKEN` secret and the tagging steps.

## License and third-party software

See `LICENSE` for the project notice. Dependencies retain their own licenses; review their notices before redistribution.
