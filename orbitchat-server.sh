#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/server/src" && -f "$SCRIPT_DIR/server/package.json" ]]; then
  APP_DIR="$SCRIPT_DIR"
elif [[ -d "$SCRIPT_DIR/../server/src" && -f "$SCRIPT_DIR/../server/package.json" ]]; then
  APP_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
else
  printf 'Cannot find the OrbitChat server source. Put this script in the project root or its scripts/ directory, alongside server/src and server/package.json.\n' >&2
  exit 1
fi
CONFIG_DIR="$APP_DIR/server-config"
ENV_FILE="$CONFIG_DIR/server.env"
LEGACY_ENV_FILE="$APP_DIR/.env"
DATA_DIR="$APP_DIR/data_server"
UPLOAD_DIR="$DATA_DIR/uploads"
LEGACY_DATA_DIR="$APP_DIR/server/data"
LEGACY_UPLOAD_DIR="$APP_DIR/server/uploads"
PID_FILE="$DATA_DIR/orbitchat-server.pid"
LOG_FILE="$DATA_DIR/orbitchat-server.log"
LEGACY_PID_FILE="$LEGACY_DATA_DIR/orbitchat-server.pid"

usage() {
  cat <<'HELP'
OrbitChat API server manager

Usage: bash scripts/orbitchat-server.sh <install|start|stop|restart|status|logs|configure-playit>

  install          Save settings, install API-only dependencies, and start
  start            Start the API server
  stop             Stop the managed API server
  restart          Restart the API server
  status           Show local, public-IP, and Playit checks
  logs             Follow the API server log
  configure-playit Save or clear the Playit public hostname and port
HELP
}

prompt_port() {
  local value
  while true; do
    read -r -p 'API local port [8787]: ' value || {
      printf 'Port input ended before a valid port was entered.\n' >&2
      return 1
    }
    value="${value:-8787}"
    if [[ "$value" =~ ^[0-9]{1,5}$ ]] && (( 10#$value >= 1 && 10#$value <= 65535 )); then
      printf '%s' "$((10#$value))"
      return
    fi
    printf 'Enter a port from 1 to 65535.\n' >&2
  done
}

set_env_value() {
  local key="$1" value="$2" temporary
  mkdir -p -- "$CONFIG_DIR"
  temporary="$(mktemp "$CONFIG_DIR/.server.env.XXXXXX")"
  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value="$value" 'BEGIN { updated=0 } index($0,key"=")==1 { print key"="value; updated=1; next } { print } END { if (!updated) print key"="value }' "$ENV_FILE" > "$temporary"
  else
    printf '%s=%s\n' "$key" "$value" > "$temporary"
  fi
  chmod 600 "$temporary"
  mv -- "$temporary" "$ENV_FILE"
}

read_env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -v key="$key" 'index($0,key"=")==1 { sub("^[^=]*=", ""); print; exit }' "$ENV_FILE"
}

resolve_config_path() {
  local value="$1"
  [[ "$value" == /* ]] || value="$APP_DIR/$value"
  realpath -m -- "$value"
}

set_env_data_paths() {
  local temporary
  temporary="$(mktemp "$CONFIG_DIR/.server.env.XXXXXX")"
  awk -v data="$DATA_DIR" -v uploads="$UPLOAD_DIR" '
    BEGIN { data_written=0; uploads_written=0 }
    index($0,"DATA_DIR=")==1 { if (!data_written) print "DATA_DIR=" data; data_written=1; next }
    index($0,"UPLOAD_DIR=")==1 { if (!uploads_written) print "UPLOAD_DIR=" uploads; uploads_written=1; next }
    { print }
    END {
      if (!data_written) print "DATA_DIR=" data
      if (!uploads_written) print "UPLOAD_DIR=" uploads
    }
  ' "$ENV_FILE" > "$temporary"
  chmod 600 "$temporary"
  mv -- "$temporary" "$ENV_FILE"
}

migrate_legacy_data_paths() {
  local configured_data configured_upload legacy_data_resolved legacy_upload_resolved
  local had_legacy_data=0 had_legacy_upload=0
  configured_data="$(read_env_value DATA_DIR)"
  configured_upload="$(read_env_value UPLOAD_DIR)"
  configured_data="${configured_data//$'\r'/}"
  configured_upload="${configured_upload//$'\r'/}"
  legacy_data_resolved="$(realpath -m -- "$LEGACY_DATA_DIR")"
  legacy_upload_resolved="$(realpath -m -- "$LEGACY_UPLOAD_DIR")"
  if [[ "$(resolve_config_path "$configured_data")" != "$legacy_data_resolved" ||
        "$(resolve_config_path "$configured_upload")" != "$legacy_upload_resolved" ]]; then
    return 0
  fi

  if managed_pid >/dev/null; then
    printf 'Existing server is still running from the legacy data folder; stop it to migrate data into %s.\n' "$DATA_DIR"
    return 0
  fi

  if [[ -d "$DATA_DIR" ]] && [[ -n "$(find "$DATA_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    printf 'Cannot migrate legacy server data automatically because %s already contains files. Back up both locations and migrate manually.\n' "$DATA_DIR" >&2
    return 1
  fi

  [[ -d "$DATA_DIR" ]] && rmdir -- "$DATA_DIR"
  if [[ -d "$LEGACY_DATA_DIR" ]]; then
    if ! mv -- "$LEGACY_DATA_DIR" "$DATA_DIR"; then
      printf 'Could not move the legacy database folder; no server data was changed.\n' >&2
      return 1
    fi
    had_legacy_data=1
  else
    mkdir -p -- "$DATA_DIR"
  fi

  if [[ -d "$LEGACY_UPLOAD_DIR" ]]; then
    if [[ -e "$UPLOAD_DIR" ]] || ! mv -- "$LEGACY_UPLOAD_DIR" "$UPLOAD_DIR"; then
      if (( had_legacy_data )); then mv -- "$DATA_DIR" "$LEGACY_DATA_DIR"; fi
      printf 'Could not move the legacy uploads folder; the old data location was restored.\n' >&2
      return 1
    fi
    had_legacy_upload=1
  else
    mkdir -p -- "$UPLOAD_DIR"
  fi

  if ! set_env_data_paths; then
    if (( had_legacy_upload )); then mv -- "$UPLOAD_DIR" "$LEGACY_UPLOAD_DIR"; fi
    if (( had_legacy_data )); then mv -- "$DATA_DIR" "$LEGACY_DATA_DIR"; fi
    printf 'Could not update server.env; the legacy data folders were restored.\n' >&2
    return 1
  fi
  rm -f -- "$PID_FILE"
  printf 'Migrated the database and uploads into %s.\n' "$DATA_DIR"
}

ensure_config() {
  local host
  mkdir -p -- "$CONFIG_DIR"
  if [[ ! -f "$ENV_FILE" && -f "$LEGACY_ENV_FILE" ]]; then
    install -m 600 "$LEGACY_ENV_FILE" "$ENV_FILE"
    printf 'Migrated existing settings from %s to %s\n' "$LEGACY_ENV_FILE" "$ENV_FILE"
  elif [[ ! -f "$ENV_FILE" && -f "$CONFIG_DIR/server.env.example" ]]; then
    install -m 600 "$CONFIG_DIR/server.env.example" "$ENV_FILE"
  elif [[ ! -f "$ENV_FILE" ]]; then
    : > "$ENV_FILE"
  fi
  [[ -f "$ENV_FILE" ]] || : > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  [[ -n "$(read_env_value PORT)" ]] || set_env_value PORT 8787
  host="$(read_env_value HOST)"
  [[ -n "$host" ]] || set_env_value HOST '0.0.0.0'
  [[ -n "$(read_env_value DATA_DIR)" ]] || set_env_value DATA_DIR "$DATA_DIR"
  [[ -n "$(read_env_value UPLOAD_DIR)" ]] || set_env_value UPLOAD_DIR "$UPLOAD_DIR"
  local upload_limit
  upload_limit="$(read_env_value MAX_UPLOAD_MB)"
  if [[ -z "$upload_limit" || "$upload_limit" == 25 || ! "$upload_limit" =~ ^[0-9]+$ ]] || (( 10#$upload_limit > 20480 )); then
    set_env_value MAX_UPLOAD_MB 20480
  fi
  [[ -n "$(read_env_value CORS_ORIGINS)" ]] || set_env_value CORS_ORIGINS null
  if ! grep -q '^PLAYIT_PUBLIC_HOST=' "$ENV_FILE"; then set_env_value PLAYIT_PUBLIC_HOST 'orbit-chat-europe.playit.plus'; fi
  if ! grep -q '^PLAYIT_PUBLIC_PORT=' "$ENV_FILE"; then set_env_value PLAYIT_PUBLIC_PORT 52152; fi
  migrate_legacy_data_paths
}

configured_port() {
  local value
  value="$(read_env_value PORT)"
  value="${value//$'\r'/}"
  if [[ ! "$value" =~ ^[0-9]{1,5}$ ]]; then
    printf 'Invalid PORT in %s. Set a value from 1 to 65535.\n' "$ENV_FILE" >&2
    return 1
  fi
  if (( 10#$value < 1 || 10#$value > 65535 )); then
    printf 'Invalid PORT in %s. Set a value from 1 to 65535.\n' "$ENV_FILE" >&2
    return 1
  fi
  printf '%s' "$((10#$value))"
}

managed_pid() {
  local pid command_line pid_file
  for pid_file in "$PID_FILE" "$LEGACY_PID_FILE"; do
    [[ -f "$pid_file" ]] || continue
    read -r pid < "$pid_file" || continue
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill -0 "$pid" 2>/dev/null || continue
    if [[ -r "/proc/$pid/cmdline" ]]; then
      command_line="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    else
      command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    fi
    [[ "$command_line" == *"$APP_DIR/server/src/index.ts"* || "$command_line" == *"\server\src\index.ts"* ]] || continue
    printf '%s' "$pid"
    return 0
  done
  return 1
}

start_server() {
  local port pid server_runner
  ensure_config
  port="$(configured_port)"
  if pid="$(managed_pid)"; then
    printf 'OrbitChat API server is already running (PID %s, local port %s).\n' "$pid" "$port"
    return
  fi
  server_runner="$APP_DIR/server/node_modules/.bin/tsx"
  if [[ ! -x "$server_runner" ]]; then
    printf 'API dependencies are missing. Run: bash scripts/orbitchat-server.sh install\n' >&2
    return 1
  fi
  chmod u+x "$server_runner" 2>/dev/null || true
  mkdir -p -- "$DATA_DIR" "$UPLOAD_DIR"
  cd "$APP_DIR"
  DOTENV_CONFIG_PATH="$ENV_FILE" nohup "$server_runner" "$APP_DIR/server/src/index.ts" >> "$LOG_FILE" 2>&1 < /dev/null &
  pid=$!
  printf '%s\n' "$pid" > "$PID_FILE"
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f -- "$PID_FILE"
    printf 'OrbitChat did not stay running. Recent log output:\n' >&2
    tail -n 40 "$LOG_FILE" >&2 || true
    return 1
  fi
  printf 'Started OrbitChat API server (PID %s, HTTP port %s).\n' "$pid" "$port"
  printf 'Configuration: %s\n' "$ENV_FILE"
  printf 'LAN access may need inbound TCP %s allowed in the host firewall (for example: sudo ufw allow %s/tcp).\n' "$port" "$port"
  printf 'A Playit agent uses an outbound tunnel; no router port-forward is needed.\n'
}

stop_server() {
  local pid attempt
  if ! pid="$(managed_pid)"; then
    rm -f -- "$PID_FILE" "$LEGACY_PID_FILE"
    printf 'OrbitChat API server is not running.\n'
    return
  fi
  kill -TERM "$pid"
  for attempt in {1..40}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f -- "$PID_FILE" "$LEGACY_PID_FILE"
      printf 'Stopped OrbitChat API server.\n'
      return
    fi
    sleep 0.25
  done
  printf 'The server did not stop within 10 seconds; check its log before trying again.\n' >&2
  return 1
}

print_status() {
  local pid port public_host public_port
  ensure_config
  port="$(configured_port)"
  public_host="$(read_env_value PLAYIT_PUBLIC_HOST)"
  public_port="$(read_env_value PLAYIT_PUBLIC_PORT)"
  if pid="$(managed_pid)"; then printf 'API process: running (PID %s)\n' "$pid"; else printf 'API process: stopped\n'; fi
  node - "$port" "$(read_env_value HOST)" "$public_host" "$public_port" "$(read_env_value MAX_UPLOAD_MB)" <<'NODE'
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const port = Number(process.argv[2]);
const configuredUploadMb = Number(process.argv[6]);
const bindHost = process.argv[3] || '127.0.0.1';
const host = process.argv[4] || '';
const publicPort = Number(process.argv[5]);
const ips = [...new Set(Object.values(os.networkInterfaces()).flatMap(items => items || [])
  .filter(item => item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
  .map(item => item.address))];
const lanUrls = bindHost === '0.0.0.0' || bindHost === '::' || ips.includes(bindHost)
  ? ips.map(ip => `http://${ip}:${port}`)
  : [];
const hasConfig = /^[a-zA-Z0-9.-]{1,253}$/.test(host) && Number.isInteger(publicPort) && publicPort >= 1 && publicPort <= 65535;
function agentIsRunning() {
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      try {
        if (['playit', 'playit-agent'].includes(fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase())) return true;
      } catch { /* Process ended or is not visible; continue scanning. */ }
    }
  } catch { return false; }
  return false;
}
async function health(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
}
async function publicIp() {
  try {
    const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const value = (await response.text()).trim();
    return response.ok && net.isIP(value) === 4 ? value : 'unavailable (lookup failed)';
  } catch { return 'unavailable (lookup failed)'; }
}
(async () => {
  console.log(`LAN IP: ${ips.length ? ips.join(', ') : 'not detected'}`);
  console.log(`Listener bind host: ${bindHost}`);
  console.log(`LAN API URL: ${lanUrls.length ? lanUrls.join(', ') : 'unavailable (listener is not bound to a LAN interface)'}`);
  console.log(`API port: ${port}`);
  console.log(`Maximum upload: ${Number.isSafeInteger(configuredUploadMb) && configuredUploadMb > 0 ? `${(configuredUploadMb / 1024).toFixed(configuredUploadMb % 1024 ? 2 : 0)} GB per file; 20 GB per request` : 'invalid configuration'}`);
  console.log(`Local API URL: http://127.0.0.1:${port}`);
  console.log(`Local health: ${await health(`http://127.0.0.1:${port}/health`) ? 'reachable' : 'not reachable'}`);
  console.log(`Detected public IP: ${await publicIp()}`);
  console.log(`Playit agent: ${agentIsRunning() ? 'process detected' : 'not detected'}`);
  if (!hasConfig) {
    console.log('Playit public hostname/IP and port: not configured');
    console.log('Playit tunnel: not configured');
  } else {
    console.log(`Playit public hostname/IP: ${host}`);
    console.log(`Playit public port: ${publicPort} (local API port: ${port})`);
    console.log(`Playit tunnel health: ${await health(`http://${host}:${publicPort}/health`) ? 'verified by HTTP health check' : 'not reachable from this host; check the agent and local port mapping'}`);
  }
  if (lanUrls.length) console.log(`For LAN clients, allow inbound TCP ${port} in the host firewall if needed.`);
  else console.log('LAN connections are disabled by the listener bind address.');
})().catch(error => { console.error('Status check failed:', error.message); process.exitCode = 1; });
NODE
}

configure_playit() {
  local host port
  ensure_config
  host="$(read_env_value PLAYIT_PUBLIC_HOST)"
  port="$(read_env_value PLAYIT_PUBLIC_PORT)"
  read -r -p "Playit public hostname/IP [$host] (blank clears Playit settings): " host
  host="${host:-$(read_env_value PLAYIT_PUBLIC_HOST)}"
  if [[ -z "$host" ]]; then
    set_env_value PLAYIT_PUBLIC_HOST ''
    set_env_value PLAYIT_PUBLIC_PORT ''
    printf 'Cleared Playit settings.\n'
    return
  fi
  if [[ ! "$host" =~ ^[a-zA-Z0-9.-]{1,253}$ ]]; then
    printf 'Enter only the public hostname or IPv4 address, without a scheme or port.\n' >&2
    return 1
  fi
  while true; do
    read -r -p "Playit public port [$port]: " port
    port="${port:-$(read_env_value PLAYIT_PUBLIC_PORT)}"
    if [[ "$port" =~ ^[0-9]{1,5}$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )); then break; fi
    printf 'Enter a port from 1 to 65535.\n' >&2
  done
  set_env_value PLAYIT_PUBLIC_HOST "$host"
  set_env_value PLAYIT_PUBLIC_PORT "$((10#$port))"
  printf 'Saved Playit endpoint %s:%s. The tunnel local target must be 127.0.0.1:%s.\n' "$host" "$((10#$port))" "$(configured_port)"
  printf 'Restart OrbitChat and the Playit agent, then run this script with status to verify the HTTP health route.\n'
}

main() {
  local action="${1:-}" log_file
  case "$action" in
    install)
      ensure_config
      command -v node >/dev/null || { printf 'Install Node.js 22 or newer first.\n' >&2; return 1; }
      command -v npm >/dev/null || { printf 'npm is required.\n' >&2; return 1; }
      (cd "$APP_DIR/server" && npm ci --omit=dev --no-audit --no-fund)
      start_server
      ;;
    start) start_server ;;
    stop) stop_server ;;
    restart) stop_server; start_server ;;
    status) print_status ;;
    logs)
      ensure_config
      log_file="$LOG_FILE"
      configured_data="$(read_env_value DATA_DIR)"
      configured_data="${configured_data//$'\r'/}"
      if [[ "$(resolve_config_path "$configured_data")" == "$(realpath -m -- "$LEGACY_DATA_DIR")" ]]; then
        log_file="$LEGACY_DATA_DIR/orbitchat-server.log"
      fi
      mkdir -p -- "$(dirname -- "$log_file")"
      touch "$log_file"
      tail -n 80 -f "$log_file"
      ;;
    configure-playit) configure_playit ;;
    -h|--help|help) usage ;;
    *) usage >&2; return 2 ;;
  esac
}

main "$@"
