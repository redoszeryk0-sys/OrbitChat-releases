# Backup and restore

OrbitChat's SQLite database stores accounts, sessions, servers, channels, messages, friendships, and metadata. Uploaded file bytes are stored separately. Back up both together.

## Desktop app

1. Exit OrbitChat so its embedded server closes and flushes the database.
2. In OrbitChat, open **Preferences → About** and copy the displayed data folder path. The database is under `data\orbitchat.sqlite`; uploaded files are under `uploads\`.
3. Copy the whole application data directory to a protected backup destination. It also contains window preferences and encrypted session-token storage.
4. Keep backups private: the database contains account and message data, and uploads may contain private files.

To restore, exit OrbitChat, keep a copy of the current data directory in case you need to roll back, replace its `data` and `uploads` folders with the matching folders from one backup, then start the app. Use the original Windows account if you want Windows-protected encrypted sessions to remain readable; otherwise sign in again.

This project does not yet create scheduled backups or encrypt the SQLite file at rest. Protect the host volume and backup destination accordingly.
