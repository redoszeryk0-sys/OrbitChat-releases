# Host the OrbitChat API

## Debian install and management

Use Debian 12 or newer with Node.js 22+ and npm. From the OrbitChat project folder, run:

```bash
bash scripts/orbitchat-server.sh install
```

The API accepts any file extension and content type up to 20 GB per file and per upload. Files are stored as opaque bytes; only known PNG/JPEG/GIF/WebP image types are eligible for inline previews, while other files are downloaded as attachments. The desktop client transfers files in resumable 1 MiB chunks, which can help with HTTP tunnels that time out on long requests. Deploy the updated API and desktop app together to enable chunked uploads. Existing `.env` files with the previous default `MAX_UPLOAD_MB=25` are automatically upgraded to `20480` MB; intentional lower limits are retained. Keep sufficient free disk space in `UPLOAD_DIR`.

Profile avatars accept JPEG, PNG, and GIF images up to 8 MB. The API stores avatar files under `UPLOAD_DIR` and their ownership/history in the SQLite database; database migration is automatic on server restart. The client keeps an additional local IndexedDB backup so avatars from a previous connection can be restored on that device. Back up both the configured upload folder and database to preserve server-side avatar history.

On first run, the text-only script saves server settings in `server-config/server.env` (mode `600`), using API port `8787` and Playit endpoint `orbit-chat-europe.playit.plus:52152` by default. Persistent data defaults to `data_server/orbitchat.sqlite`, with uploaded files in `data_server/uploads/`; these are separate from the `server/` source folder. Edit `server.env` to change the bind host, local port, data/upload folders, upload limit, Playit endpoint, CORS or integrations; run `restart` after changing it. The old project-root `.env` is migrated to this file automatically if it exists. On an existing install using the old default `server/data` and `server/uploads` folders, stop the API and start it again with the updated manager to migrate those folders into `data_server`. The script refuses automatic migration if the new data folder already contains files or if custom data paths are configured. A starter template lives at `server-config/server.env.example`. The script installs only the API's runtime dependencies under `server`, then starts the HTTP server. It does not install Windows/Electron desktop dependencies or require a compile step. The server binds to `0.0.0.0` by default so LAN clients and the Playit agent can reach it.

Manage it with:

```bash
bash scripts/orbitchat-server.sh status
bash scripts/orbitchat-server.sh logs
bash scripts/orbitchat-server.sh restart
bash scripts/orbitchat-server.sh stop
```

The server stores its SQLite database and uploaded files separately from the source code, under `data_server/` and `data_server/uploads/` by default. Its log and PID are also kept in `data_server/`. `status` probes the local `/health` endpoint; a failed public Playit probe is reported as unverified from that host, never as a successful tunnel. Keep adequate disk space for uploaded files, particularly if you use the 20 GB upload cap.

## LAN access

At startup, OrbitChat prints LAN IP and URL, the local port and URL, detected public IP, and configured Playit public hostname/IP and public port as distinct values. Share the LAN URL only with people on the same network, for example `http://192.168.1.20:8787`. Allow inbound TCP on the **local API port** in the host firewall if needed; with UFW, use `sudo ufw allow 8787/tcp` and substitute your configured port. A detected public IP alone does not prove that the server is reachable from the internet.

## Playit.gg TCP tunnel

1. Install and claim the Playit agent using [Playit's Debian/Linux guide](https://playit.gg/support/run-on-linux/).
2. In Playit, create a **TCP** tunnel for the same agent. Set its local destination to `127.0.0.1` and the **local API port** printed by OrbitChat. Playit assigns a public hostname/IP and public port; that public port can differ from the local port. TCP tunnel availability depends on the current Playit account options.
3. The server manager already defaults the public endpoint to `orbit-chat-europe.playit.plus:52152`; verify that matches your Playit tunnel, then update `server-config/server.env` if it differs. The interactive command can also edit it while keeping the current values when you press Enter:

   ```bash
   bash scripts/orbitchat-server.sh configure-playit
   bash scripts/orbitchat-server.sh status
   ```

   Enter only the public hostname/IP and public port. `status` distinguishes the local API health check, agent-process detection, configured public endpoint, and a successful public `/health` response. It never reports tunnel reachability just because the agent is running. Some networks block access to their own public tunnel; if the external check fails, ask a friend to test the address before concluding the tunnel is down.
4. Friends do **not** install the agent. In OrbitChat, open **Settings → Connection** (or **Server address** before signing in) and enter `http://HOST:PUBLIC_PORT`. Use the public port shown by Playit, not the local API port.

The agent creates an outbound tunnel, so router port-forwarding is not needed. The local firewall must allow the Playit agent to reach the local API port; LAN clients also need inbound TCP on the local port. HTTP does not encrypt passwords or messages; use it only on a network you trust. Do not expose the local API port directly to the internet. Voice remains peer-to-peer and may need a TURN server on restrictive networks.

## Windows desktop host

The desktop app shows its LAN address, local port, Playit public address, agent detection, and tunnel health in the main sidebar. Copy buttons copy the full API URLs. To give the embedded server a stable port and configure Playit, create `%APPDATA%\OrbitChat\.env` before restarting the app:

```dotenv
PORT=8787
PLAYIT_PUBLIC_HOST=your-agent.playit.gg
PLAYIT_PUBLIC_PORT=12345
```

Map the Playit TCP tunnel to `127.0.0.1:8787`. Replace the example host and public port with the values shown by Playit. For LAN access, allow inbound TCP `8787` in Windows Firewall if prompted. The app's **Settings → Connection** page lets you save a different API URL and sign in again.
