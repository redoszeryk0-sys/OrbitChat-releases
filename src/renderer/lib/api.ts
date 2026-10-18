export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function normalizeServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Enter an HTTP or HTTPS server address.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Enter the server origin, without a path or credentials.');
  return url.origin;
}

export function resolveServerAssetUrl(baseUrl: string, resourceUrl?: string | null): string | undefined {
  if (!resourceUrl) return undefined;
  if (/^(?:https?:|blob:|data:)/i.test(resourceUrl)) return resourceUrl;
  return new URL(resourceUrl, baseUrl).toString();
}

export function avatarZoom(url?: string | null): number {
  const zoomText = url?.match(/[?&]zoom=([\d.]+)/)?.[1];
  const zoom = zoomText ? Number(zoomText) : 1;
  return Number.isFinite(zoom) ? Math.max(1, Math.min(3, zoom)) : 1;
}

export async function apiRequest<T>(baseUrl: string, token: string | null, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(`${baseUrl}${path}`, { ...init, headers, mode: 'cors', cache: 'no-store' }); }
  catch { throw new ApiError('Unable to connect to this server. Check the address and your network connection.', 0); }
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(payload.error ?? `The server returned HTTP ${response.status}.`, response.status);
  return payload as T;
}

export async function authorizedBlob(baseUrl: string, token: string, path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` }, mode: 'cors', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 413 ? 'This upload is larger than the server limit. Increase MAX_UPLOAD_MB in the server .env, restart the server, and try again.' : 'This attachment is not available.');
  return URL.createObjectURL(await response.blob());
}

export interface LocalAvatarBackup { id: string; image: Blob; contentType: string; zoom: number; createdAt: string }

function openAvatarBackupDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Local avatar backup is unavailable.')); return; }
    const request = indexedDB.open('orbitchat-avatar-backups', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('avatars')) database.createObjectStore('avatars', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local avatar backup could not be opened.'));
  });
}

export async function saveLocalAvatarBackup(backup: LocalAvatarBackup): Promise<void> {
  const database = await openAvatarBackupDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('avatars', 'readwrite');
    transaction.objectStore('avatars').put({ ...backup, zoom: Math.max(1, Math.min(3, backup.zoom)) });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Local avatar backup could not be saved.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Local avatar backup could not be saved.'));
  }).finally(() => database.close());
}

export async function getLocalAvatarBackup(id: string): Promise<LocalAvatarBackup | null> {
  const database = await openAvatarBackupDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('avatars', 'readonly');
    const request = transaction.objectStore('avatars').get(id);
    request.onsuccess = () => resolve((request.result as LocalAvatarBackup | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('Local avatar backup could not be read.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Local avatar backup could not be read.')); };
  });
}

export async function listLocalAvatarBackups(userId: string): Promise<LocalAvatarBackup[]> {
  const database = await openAvatarBackupDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('avatars', 'readonly');
    const request = transaction.objectStore('avatars').getAll();
    request.onsuccess = () => resolve((request.result as LocalAvatarBackup[]).filter((item) => item.id.startsWith(`${userId}:`)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error ?? new Error('Local avatar history could not be read.'));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Local avatar history could not be read.')); };
  });
}

export function uploadAttachmentsWithProgress(
  baseUrl: string,
  token: string,
  files: File[],
  onProgress: (progress: { percent: number; bytesPerSecond: number }) => void,
  signal?: AbortSignal
): Promise<{ attachments: import('./types').Attachment[] }> {
  const chunkBytes = 1024 * 1024;
  const requestJson = async <T>(path: string, init: RequestInit, useAbortSignal = true): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
        ...(useAbortSignal && signal ? { signal } : {})
      });
    } catch {
      throw new ApiError(signal?.aborted ? 'The upload was cancelled.' : 'Unable to connect to this server. Check the address and your network connection.', 0);
    }
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new ApiError(payload.error ?? `The server returned HTTP ${response.status}.`, response.status);
    return payload as T;
  };
  const sendChunk = (uploadId: string, offset: number, chunk: Blob, onLoaded: (loaded: number) => void): Promise<void> => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => xhr.abort();
    xhr.open('PUT', `${baseUrl}/api/attachments/chunked/${encodeURIComponent(uploadId)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Offset', String(offset));
    xhr.upload.addEventListener('progress', (event) => onLoaded(Math.min(chunk.size, event.loaded)));
    xhr.addEventListener('error', () => finish(new ApiError('Unable to connect to this server. Check the address and your network connection.', 0)));
    xhr.addEventListener('abort', () => finish(new ApiError('The upload was cancelled.', 0)));
    xhr.addEventListener('load', () => {
      let payload: { error?: string } = {};
      try { payload = JSON.parse(xhr.responseText) as typeof payload; } catch { /* use status fallback */ }
      if (xhr.status < 200 || xhr.status >= 300) finish(new ApiError(payload.error ?? `The server returned HTTP ${xhr.status}.`, xhr.status));
      else finish();
    });
    if (signal?.aborted) { finish(new ApiError('The upload was cancelled.', 0)); return; }
    signal?.addEventListener('abort', abort, { once: true });
    xhr.send(chunk);
  });

  return (async () => {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const uploaded: import('./types').Attachment[] = [];
    let completedBytes = 0;
    let lastLoaded = 0;
    let lastTime = performance.now();
    for (const file of files) {
      const session = await requestJson<{ uploadId: string; chunkBytes: number }>('/api/attachments/chunked', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, contentType: file.type || 'application/octet-stream', size: file.size })
      });
      try {
        const chunkSize = Math.max(1, Math.min(chunkBytes, session.chunkBytes || chunkBytes));
        for (let offset = 0; offset < file.size;) {
          const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size));
          let saved = false;
          for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
            try {
              await sendChunk(session.uploadId, offset, chunk, (loaded) => {
                const overallLoaded = completedBytes + offset + loaded;
                const now = performance.now();
                const elapsed = Math.max((now - lastTime) / 1000, 0.001);
                const bytesPerSecond = Math.max(0, (overallLoaded - lastLoaded) / elapsed);
                lastLoaded = overallLoaded;
                lastTime = now;
                onProgress({ percent: totalBytes ? Math.min(99, Math.round(overallLoaded / totalBytes * 100)) : 0, bytesPerSecond });
              });
              saved = true;
            } catch (error) {
              if (signal?.aborted) throw error;
              const chunkEnd = offset + chunk.size;
              let synchronized = false;
              for (let poll = 0; poll < 12; poll += 1) {
                if (poll > 0) await new Promise((resolve) => window.setTimeout(resolve, 500));
                try {
                  const state = await requestJson<{ receivedBytes: number }>(`/api/attachments/chunked/${encodeURIComponent(session.uploadId)}`, { method: 'GET' });
                  if (state.receivedBytes === chunkEnd) { saved = true; synchronized = true; break; }
                  if (state.receivedBytes !== offset) throw new ApiError('Upload offset changed unexpectedly; cancel and retry the file.', 409);
                  synchronized = true;
                } catch (stateError) {
                  if (stateError instanceof ApiError && stateError.status === 409) throw stateError;
                  synchronized = false;
                }
              }
              if (!saved && (!synchronized || attempt === 2)) throw error;
            }
          }
          offset += chunk.size;
        }
        const result = await requestJson<{ attachment: import('./types').Attachment }>(`/api/attachments/chunked/${encodeURIComponent(session.uploadId)}/complete`, { method: 'POST' });
        uploaded.push(result.attachment);
        completedBytes += file.size;
      } catch (error) {
        void requestJson(`/api/attachments/chunked/${encodeURIComponent(session.uploadId)}`, { method: 'DELETE' }, false).catch(() => undefined);
        throw error;
      }
    }
    onProgress({ percent: 100, bytesPerSecond: 0 });
    return { attachments: uploaded };
  })();
}

export function formatTransferRate(bytesPerSecond: number): string {
  const safeRate = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  if (safeRate < 1024) return `${Math.round(safeRate)} B/s`;
  if (safeRate < 1024 * 1024) return `${Math.round(safeRate / 1024)} KB/s`;
  return `${(safeRate / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
