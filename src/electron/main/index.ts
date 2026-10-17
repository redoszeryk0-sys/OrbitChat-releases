import { app, BrowserWindow, dialog, ipcMain, net as electronNet, Notification, safeStorage, session, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

let mainWindow: BrowserWindow | null = null;
let trustedDevOrigin = 'http://127.0.0.1:5173';
const fixedApiUrl = 'https://h3icc3.zgrok.io';

const sessionFile = () => path.join(app.getPath('userData'), 'secure-sessions.json');
const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function readJson<T>(filePath: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T; } catch { return fallback; }
}

function normalizedOrigin(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid server address.');
  if (input === 'local') return input;
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Enter a server origin, without a path or credentials.');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Enter an HTTP or HTTPS server address.');
  return url.origin;
}

function runtimeInfo() {
  return {
    name: app.getName(), version: app.getVersion(), localApiUrl: fixedApiUrl,
    lanIp: null, lanApiUrl: null, port: 443, publicIp: null,
    playitPublicHost: null, playitPublicPort: null, playitAgentRunning: false,
    playitAgentLocation: 'unknown', playitTunnelReachable: null,
    userDataPath: app.getPath('userData'), encryptionAvailable: safeStorage.isEncryptionAvailable()
  };
}

function assertTrustedSender(event: Pick<Electron.IpcMainEvent, 'sender' | 'senderFrame'>): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Untrusted application window.');
  const url = event.senderFrame?.url ?? '';
  const isDev = url.startsWith(`${trustedDevOrigin}/`) || url === trustedDevOrigin;
  const isApp = url.startsWith('file://') && url.includes('dist/');
  if (!isDev && !isApp) throw new Error('Untrusted application window.');
}

function registerIpcHandlers(): void {
  ipcMain.handle('orbit:runtime', async (event) => {
    assertTrustedSender(event);
    return runtimeInfo();
  });
  ipcMain.handle('orbit:notify', (event, title: unknown, body: unknown) => {
    assertTrustedSender(event);
    if (typeof title !== 'string' || typeof body !== 'string' || !title.trim() || title.length > 120 || body.length > 240 || !Notification.isSupported()) return false;
    const notification = new Notification({ title: title.trim(), body, silent: true });
    notification.on('click', () => {
      if (!mainWindow) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
    notification.show();
    return true;
  });
  ipcMain.handle('orbit:session:get', (event, serverInput: unknown) => {
    assertTrustedSender(event);
    if (!safeStorage.isEncryptionAvailable()) return null;
    const origin = normalizedOrigin(serverInput);
    const encrypted = readJson<Record<string, string>>(sessionFile(), {})[origin];
    if (!encrypted) return null;
    try { return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); } catch { return null; }
  });
  ipcMain.handle('orbit:session:set', (event, serverInput: unknown, tokenInput: unknown) => {
    assertTrustedSender(event);
    const origin = normalizedOrigin(serverInput);
    const sessions = readJson<Record<string, string>>(sessionFile(), {});
    if (tokenInput === null) delete sessions[origin];
    else {
      if (typeof tokenInput !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(tokenInput)) throw new Error('Invalid session token.');
      if (!safeStorage.isEncryptionAvailable()) return false;
      sessions[origin] = safeStorage.encryptString(tokenInput).toString('base64');
    }
    const filePath = sessionFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(sessions), { mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
    return true;
  });
  ipcMain.handle('orbit:open-external', async (event, value: unknown) => {
    assertTrustedSender(event);
    if (typeof value !== 'string' || value.length > 2048) return false;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      await shell.openExternal(url.href);
      return true;
    } catch { return false; }
  });
  ipcMain.handle('orbit:download-attachment', async (event, baseInput: unknown, attachmentPathInput: unknown, tokenInput: unknown) => {
    assertTrustedSender(event);
    let origin: string;
    try { origin = normalizedOrigin(baseInput); }
    catch { throw new Error('Invalid attachment server address.'); }
    if (typeof attachmentPathInput !== 'string' || !/^\/api\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentPathInput)) throw new Error('Invalid attachment address.');
    if (typeof tokenInput !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(tokenInput)) throw new Error('Sign in to download this file.');
    const response = await electronNet.fetch(`${origin}${attachmentPathInput}`, {
      headers: { Authorization: `Bearer ${tokenInput}` },
      signal: AbortSignal.timeout(6 * 60 * 60 * 1000)
    });
    if (!response.ok || !response.body) throw new Error(response.status === 401 ? 'Sign in again to download this file.' : `File download failed (HTTP ${response.status}).`);
    const disposition = response.headers.get('content-disposition') ?? '';
    const suggestedName = disposition.match(/filename="([^"]+)"/i)?.[1]?.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Orbit-Chat-attachment';
    const window = mainWindow ?? BrowserWindow.getFocusedWindow();
    if (!window) { await response.body.cancel(); throw new Error('No Orbit Chat window is available to save this file.'); }
    const choice = await dialog.showSaveDialog(window, {
      title: 'Save Orbit Chat attachment', defaultPath: suggestedName, buttonLabel: 'Save file',
      properties: ['showOverwriteConfirmation', 'createDirectory']
    });
    if (choice.canceled || !choice.filePath) { await response.body.cancel(); return false; }
    try {
      await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(choice.filePath, { flags: 'w' }));
      return true;
    } catch (error) {
      fs.rmSync(choice.filePath, { force: true });
      throw new Error(error instanceof Error ? `Could not save the file: ${error.message}` : 'Could not save the file.');
    }
  });
  ipcMain.on('orbit:window:minimize', (event) => { assertTrustedSender(event); BrowserWindow.fromWebContents(event.sender)?.minimize(); });
  ipcMain.on('orbit:window:toggle-maximize', (event) => { assertTrustedSender(event); const window = BrowserWindow.fromWebContents(event.sender); if (window?.isMaximized()) window.unmaximize(); else window?.maximize(); });
  ipcMain.on('orbit:window:close', (event) => { assertTrustedSender(event); BrowserWindow.fromWebContents(event.sender)?.close(); });
  ipcMain.handle('orbit:window:is-maximized', (event) => { assertTrustedSender(event); return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false; });
}

function saveWindowBounds(window: BrowserWindow): void {
  if (window.isMaximized() || window.isMinimized()) return;
  const [width, height] = window.getSize(), [x, y] = window.getPosition();
  const filePath = boundsFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ width, height, x, y }));
}

async function createWindow(): Promise<void> {
  const saved = readJson<{ width?: number; height?: number; x?: number; y?: number }>(boundsFile(), {});
  mainWindow = new BrowserWindow({
    width: Math.max(900, Math.min(1700, saved.width ?? 1360)),
    height: Math.max(620, Math.min(1100, saved.height ?? 860)),
    ...(Number.isFinite(saved.x) && Number.isFinite(saved.y) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 860, minHeight: 560,
    backgroundColor: '#111318',
    title: 'Orbit Chat',
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('resize', () => mainWindow && saveWindowBounds(mainWindow));
  mainWindow.on('move', () => mainWindow && saveWindowBounds(mainWindow));
  mainWindow.on('maximize', () => mainWindow?.webContents.send('orbit:window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('orbit:window:maximized', false));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? url.startsWith('file://') : url.startsWith(trustedDevOrigin);
    if (!allowed) event.preventDefault();
  });
  if (app.isPackaged) await mainWindow.loadFile(path.join(app.getAppPath(), 'dist/index.html'));
  else await mainWindow.loadURL(trustedDevOrigin);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.setAppUserModelId('com.orbitlabs.orbitchat');
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    trustedDevOrigin = process.env.VITE_DEV_SERVER_URL ?? trustedDevOrigin;
    registerIpcHandlers();
    const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self' https: http: ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-src 'none'";
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.url.startsWith('file://') || details.url.startsWith(trustedDevOrigin)) callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
      else callback({ responseHeaders: details.responseHeaders });
    });
    const trustedOrigin = (origin: string) => origin === 'file://' || origin === 'null' || origin === trustedDevOrigin;
    session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (!mainWindow || contents !== mainWindow.webContents || !trustedOrigin(origin)) return false;
      return permission === 'media' && details.mediaType === 'audio';
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : '';
      let origin = '';
      try { origin = new URL(requestingUrl).origin; } catch { origin = ''; }
      const trusted = Boolean(mainWindow && contents === mainWindow.webContents && trustedOrigin(origin));
      if (trusted && permission === 'media' && 'mediaTypes' in details && details.mediaTypes?.includes('audio') && !details.mediaTypes.includes('video')) return callback(true);
      return callback(false);
    });
    await createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  }).catch((error) => {
    console.error('Orbit Chat failed to start:', error);
    app.quit();
  });
}
