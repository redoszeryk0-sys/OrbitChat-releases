import { contextBridge, ipcRenderer } from 'electron';

const orbitApi = Object.freeze({
  runtime: () => ipcRenderer.invoke('orbit:runtime'),
  getSession: (serverUrl: string) => ipcRenderer.invoke('orbit:session:get', serverUrl),
  saveSession: (serverUrl: string, token: string | null) => ipcRenderer.invoke('orbit:session:set', serverUrl, token),
  openExternal: (url: string) => ipcRenderer.invoke('orbit:open-external', url),
  downloadAttachment: (serverUrl: string, attachmentPath: string, token: string) => ipcRenderer.invoke('orbit:download-attachment', serverUrl, attachmentPath, token),
  window: Object.freeze({
    minimize: () => ipcRenderer.send('orbit:window:minimize'),
    toggleMaximize: () => ipcRenderer.send('orbit:window:toggle-maximize'),
    close: () => ipcRenderer.send('orbit:window:close'),
    isMaximized: () => ipcRenderer.invoke('orbit:window:is-maximized'),
    onMaximized: (callback: (maximized: boolean) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => { if (typeof value === 'boolean') callback(value); };
      ipcRenderer.on('orbit:window:maximized', listener);
      return () => ipcRenderer.removeListener('orbit:window:maximized', listener);
    }
  })
});

contextBridge.exposeInMainWorld('orbit', orbitApi);
