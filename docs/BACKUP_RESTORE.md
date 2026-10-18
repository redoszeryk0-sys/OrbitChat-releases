# Backup and restore

OrbitChat's SQLite database stores accounts, sessions, servers, channels, messages, friendships, and metadata. Uploaded file bytes are stored separately. Back up both together.

## Desktop app

1. Exit OrbitChat so its embedded server closes and flushes the database.
2. In OrbitChat, open **Preferences → About** and copy the displayed data folder path. The database is under `data\orbitchat.sqlite`; uploaded files are under `uploads\`.
3. Copy the whole application data directory to a protected backup destination. It also contains window preferences and encrypted session-token storage.
4. Keep backups private: the database contains account and message data, and uploads may contain private files.

To restore, exit OrbitChat, keep a copy of the current data directory in case you need to roll back, replace its `data` and `uploads` folders with the matching folders from one backup, then start the app. Use the original Windows account if you want Windows-protected encrypted sessions to remain readable; otherwise sign in again.

## Standalone server

1. Stop the server process.
2. Copy the configured `DATA_DIR` (the file `orbitchat.sqlite`) and `UPLOAD_DIR` together, preserving the folder structure. With the Debian manager's default configuration these are `data_server/` and `data_server/uploads/`.
3. Store the backup with access controls and encryption appropriate for private account and message data.

To restore, stop the server, keep the current database and uploads as a rollback copy, restore both paths from the same backup, and restart the server. Restoring only the database may leave attachment records whose files are missing; restoring only uploads leaves unreferenced files. Test a restore periodically on a separate copy of the server data.

This project does not yet create scheduled backups or encrypt the SQLite file at rest. Protect the host volume and backup destination accordingly.
