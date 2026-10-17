export {};

declare global {
  interface Window {
    orbit: {
      runtime(): Promise<{
        name: string; version: string; localApiUrl: string; lanIp: string | null; lanApiUrl: string | null; port: number;
        publicIp: string | null; playitPublicHost: string | null; playitPublicPort: number | null;
        playitAgentRunning: boolean; playitAgentLocation: 'this-pc' | 'unknown'; playitTunnelReachable: boolean | null;
        userDataPath: string; encryptionAvailable: boolean;
      }>;
      getSession(serverUrl: string): Promise<string | null>;
      saveSession(serverUrl: string, token: string | null): Promise<boolean>;
      openExternal(url: string): Promise<boolean>;
      downloadAttachment(serverUrl: string, attachmentPath: string, token: string): Promise<boolean>;
      window: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximized(callback: (maximized: boolean) => void): () => void;
      };
    };
  }
}
