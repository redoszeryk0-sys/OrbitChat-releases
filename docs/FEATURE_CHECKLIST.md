# Feature checklist

Status reflects the implemented 0.1.0 build. “Tested” means covered by the current automated tests or the installed-app smoke check; “implemented” means present in the app but not covered end-to-end. A successful compile alone is not counted as feature verification.

## Working and tested

| Area | Status | Evidence / scope |
| --- | --- | --- |
| Registration, duplicate-name handling, invalid-password handling, login/session validation, and authorization | Tested | `npm test`; API tests exercise account creation, duplicate rejection, invalid login, authenticated and unauthenticated access. |
| Server create/join and membership checks | Tested | `npm test`; non-members are denied and invited users can join. |
| Channel messages, history after server restart, edits, reactions, and live channel delivery | Tested | `npm test`; separate Socket.IO clients receive message and edit events. |
| Friend request acceptance, direct-message access checks, and live DM delivery | Tested | `npm test`. |
| Arbitrary file extensions and binary bytes are accepted; only known image MIME types are served inline | Tested | `npm test` verifies unknown-extension upload/download byte-for-byte and safe generic content type. This does not scan files for malware. |
| Server-member @mentions by username or display name, autocomplete, visual highlight, and mention notification | Tested | `npm test`; API rejects forged/nonmember mentions and sends a realtime ping only to mentioned accounts. |
| Arbitrary file upload, resumable 1 MiB chunks, and 20 GB per-file/combined upload limit | Tested | `npm test` verifies binary upload/download, authenticated chunk offsets/resume/completion, streamed storage, and upload-cap configuration. HTTP tunnel timeout behavior still requires verification through the deployment's actual tunnel. |
| JPEG, PNG, and GIF profile avatars, circular zoom editor, server-persisted avatar history, and restore | Tested | API tests verify image signatures, exact-byte storage/serving, per-user history authorization, and restoring an earlier avatar. Animated GIFs are stored without conversion. |
| Password hashes, random opaque session tokens stored as hashes, auth rate limiting, and socket authentication | Implemented | Server-side checks; not a formal penetration/security audit. |
| Message and channel delete confirmations | Implemented | OrbitChat-styled alert dialogs show what will be removed and provide Cancel and Delete actions. |
| File access authorization, message replies, soft deletion, Unicode emoji/stickers, sanitized Markdown, image preview/download | Implemented | Exercised in UI/API; broader browser-based regression coverage remains. |
| NSIS Setup Wizard, per-user/all-user installation choices, OrbitChat styling, and app launch | Implemented | Themed MUI wizard and animated install-status page compile into NSIS; final interactive flow and both elevation paths still need on-device validation. Installer is unsigned. |
| Installed-app UI smoke check | Tested | Registered and signed into a local account, created a server with its default channels, sent a channel message, opened the emoji picker, then relaunched the installed app and confirmed the session and workspace returned. Synthetic QA data was removed afterward. |
| Emoji picker presentation | Tested | Packaged-app visual check confirmed the Orbit header, one-tap emoji row, themed searchable grid, and picker layout. Selecting a quick emoji was not exercised in this pass. |

## Partial

| Area | Current limit |
| --- | --- |
| Roles and server management | Owner/admin/member checks exist, and channels can be managed. No full role editor, permissions matrix, server ownership transfer, server deletion/leave workflow, or category editor. |
| Private channels | Backend permission checks and membership schema exist; the complete administrator-facing management flow is not finished. |
| Search | Message search is limited to messages available through the current app view; no complete cross-server/user/channel quick switcher. |
| Notifications and presence | Socket presence and basic desktop notifications work. There are no complete unread/mention counters, per-channel notification levels, sound settings, or activity status. |
| Voice | Peer-to-peer audio mesh with mute/deafen, leave, a voice-room participant grid, active-speaker indicators, and microphone/speaker device selectors. No camera video, screen sharing, SFU, or noise suppression controls. TURN is optional and must be supplied by the host. |
| Reports/moderation | Users can submit reports. There is no moderator queue or complete audit-log review UI. |
| GIFs | Tenor-backed search/share is implemented, but requires the host to configure a Tenor API key. Without it the UI shows an unavailable/configuration message and does not invent results. |
| Schema upgrades | A version-1 SQLite baseline and migration tracking table are present. A versioned upgrade path for future schema revisions has not yet been exercised or added. |
| Data lifecycle | SQLite is persistent and backup/restore is documented. There is no scheduled backup, password reset/email verification flow, account deletion UI, or data-retention policy. |
| Settings | Theme, font scale, reduced motion, sidebar collapse, profile/status, and desktop notification preference work. Many requested privacy, keybind, language, voice, and media controls are not implemented. |
| Updates | Implemented: checks GitHub for a newer stable ZIP release, shows an update notification/icon, and launches the updater bundled in the portable app. It verifies the ZIP and preserves account data. Older installations without a bundled updater must be installed using the current Online Installer. |

## Unavailable in this release

- Message pins, threads, message links/deep links, rich embed previews, and bulk history search.
- Video calls, screen sharing, group SFU voice, voice recording, and advanced audio controls.
- User blocking, complete profile cards, administrative report triage, and full moderation tools.
- Automatic updates, code signing, scheduled backup, and production hosting.

## Current verification

- `npm run typecheck`: passed.
- `npm test`: 3 test cases passed (accounts/server/realtime/persistence; friend/DM permissions; attachment signature validation).
- `npm run build`: passed after the final source changes (Electron build and Vite production build).
- `npm run dist:win`: passed; generated the x64 NSIS Setup Wizard and installed/launched the app. The installer is unsigned.
- Packaged-app UI smoke check: registration/login, server/channel creation, message send, emoji picker, and session persistence after relaunch passed. QA records were removed and the original empty local database was restored.
- Vite reports a main entry chunk of about 516 kB before gzip; the emoji picker is a separate lazy-loaded chunk. This is a build-size warning, not a build failure.
- A public/internet-facing server and external TURN/Tenor configuration were not tested.
