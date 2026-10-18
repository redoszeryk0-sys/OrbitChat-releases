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
npm run zip:portable
npm run installer:online
npm run installer:updater
```

The desktop app includes its embedded API code under `server/src`.

`build:portable` prepares the Windows x64 app folder. `zip:portable` includes the updater inside the versioned portable ZIP; by default, it writes the ZIP to the sibling `Orbit Chat Bundled Updater Builds` folder. Pass `-OutputDirectory` to `scripts/build-portable-zip.ps1` to choose another location. See [`installer/OfflineInstaller/README.md`](installer/OfflineInstaller/README.md) and [`installer/Updater/README.md`](installer/Updater/README.md) for installer and updater details.

## Project files

- `src/` — Electron desktop application and renderer
- `server/src/` — embedded API code used by the application
- `tests/`, `server/test/` — automated tests
- `installer/OfflineInstaller/` - Windows online installer and uninstaller source
- `installer/Updater/` - standalone, bundled app updater source
- `scripts/`, `docs/` - portable build scripts and application documentation
- `build/` - Windows app and installer artwork/configuration

## License and third-party software

See `LICENSE` for the project notice. Dependencies retain their own licenses; review their notices before redistribution.
