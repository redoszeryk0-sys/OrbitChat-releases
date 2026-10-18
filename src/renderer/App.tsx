import { FormEvent, KeyboardEvent, MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  Activity, ArrowDown, AtSign, Bell, BellOff, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp,
  Compass, Copy, Download, File, FileImage, FolderPlus, Hash, Headphones, Image, Info, LoaderCircle, LogOut, Menu,
  MessageCircle, Mic, MicOff, MoreHorizontal, Paperclip, Plus, Reply, Search, Send, Settings, Smile,
  Sticker, Sun, Moon, Trash2, Users, Volume2, VolumeX, X, Video, Zap
} from 'lucide-react';
import { ApiError, apiRequest, avatarZoom, formatBytes, formatTransferRate, getLocalAvatarBackup, listLocalAvatarBackups, normalizeServerUrl, resolveServerAssetUrl, saveLocalAvatarBackup, uploadAttachmentsWithProgress } from './lib/api';
import { unknownSlashCommandMessage } from './lib/commands';
import { isNearLatest, shouldSendComposerOnEnter, uniqueSelectableAudioDevices } from './lib/chatUi';
import { findMentionMatches, insertMention, mentionQueryAtCaret, mentionedMemberIds } from './lib/mentions';
import type { Attachment, Category, Channel, Member, Message, Server, User } from './lib/types';
import { useVoice } from './lib/useVoice';
import { MessageRow } from './components/MessageRow';
import { OrbitEmojiPicker } from './components/OrbitEmojiPicker';
import './styles.css';

type ThemeMode = 'dark' | 'light' | 'system';
type ConnectionStatus = 'checking' | 'online' | 'offline';
type PickerMode = 'emoji' | 'gif' | 'sticker' | 'attach' | null;
type DialogMode = 'server' | 'join' | 'channel' | 'category' | 'invite' | 'profile' | 'settings' | null;
type ConfirmAction = { kind: 'message'; message: Message } | { kind: 'channel'; channel: Channel };
interface ChannelMenuState { channel: Channel; left: number; top: number; canManage: boolean; canDelete: boolean }
interface ChannelAreaMenuState { left: number; top: number; categoryId: string | null }
interface Runtime {
  name: string; version: string; localApiUrl: string; lanIp: string | null; lanApiUrl: string | null; port: number;
  publicIp: string | null; playitPublicHost: string | null; playitPublicPort: number | null;
  playitAgentRunning: boolean; playitAgentLocation: 'this-pc' | 'unknown'; playitTunnelReachable: boolean | null;
  userDataPath: string; encryptionAvailable: boolean;
}
interface GifItem { id: string; title: string; url: string; previewUrl: string; width: number; height: number }
interface Bootstrap { user: User; servers: Server[] }
interface AvatarHistoryItem { id: string; contentType: string; zoom: number; createdAt: string; url: string; local?: boolean }
interface ToastValue { id: number; text: string }
interface ChannelMessagePayload { content: string; kind: 'text' | 'gif'; mediaUrl?: string; replyToId?: string; attachmentIds: string[]; mentions: string[] }
interface PendingSend { payload: ChannelMessagePayload; files: File[]; channelId?: string; conversationId?: string; uploaded?: Attachment[]; gif?: GifItem; gifQuery?: string; abortController?: AbortController }
interface QueuedFile { id: string; file: File }
interface TypingUser { room: string; userId: string; displayName: string }

const stickers = [
  { emoji: '🌙', name: 'Orbit moon' }, { emoji: '🪐', name: 'Ringed planet' }, { emoji: '🚀', name: 'Launch' },
  { emoji: '☄️', name: 'Comet' }, { emoji: '🌟', name: 'Star burst' }, { emoji: '🛰️', name: 'Satellite' },
  { emoji: '👾', name: 'Space visitor' }, { emoji: '🛸', name: 'Flying saucer' }, { emoji: '✨', name: 'Sparkles' },
  { emoji: '💫', name: 'Dizzy star' }, { emoji: '🌍', name: 'Home planet' }, { emoji: '🌌', name: 'Galaxy' }
];

let avatarApiUrl = '';

async function readLocalAvatarHistory(userId: string): Promise<AvatarHistoryItem[]> {
  try {
    return (await listLocalAvatarBackups(userId)).map((item) => ({ id: item.id, contentType: item.contentType, zoom: item.zoom, createdAt: item.createdAt, url: URL.createObjectURL(item.image), local: true }));
  } catch { return []; }
}

function absoluteAvatarUrl(url?: string | null) {
  return resolveServerAssetUrl(avatarApiUrl, url);
}

function Avatar({ label, url, size = 'normal', status }: { label: string; url?: string | null; size?: 'normal' | 'small' | 'large'; status?: string }) {
  const first = label.trim().charAt(0).toUpperCase() || '?';
  const zoom = avatarZoom(url);
  return <span className={`avatar avatar-${size}`}>
    {url ? <img src={absoluteAvatarUrl(url)} alt="" style={zoom === 1 ? undefined : { transform: `scale(${zoom})` }} /> : <span>{first}</span>}
    {status && <i className={`presence-dot presence-${status}`} />}
  </span>;
}

function Logo({ small = false }: { small?: boolean }) {
  return <span className={`orbit-logo ${small ? 'orbit-logo-small' : ''}`} aria-hidden="true"><span /><i /></span>;
}

function messageTime(value: string) {
  const date = new Date(value), today = new Date();
  if (date.toDateString() === today.toDateString()) return `Today at ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function readMutedChannelIds() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('orbit.mutedChannels') ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set<string>(); }
}

function readUnreadChannelIds() {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('orbit.unreadChannels') ?? '[]');
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set<string>(); }
}

function App() {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [sessionCheckComplete, setSessionCheckComplete] = useState(false);
  const [bootMessage, setBootMessage] = useState('Starting Orbit Chat');
  const [apiUrl, setApiUrl] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [availableUpdate, setAvailableUpdate] = useState<{ tag: string; version: string; notes: string } | null>(null);
  const [updaterLaunching, setUpdaterLaunching] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [socket, setSocket] = useState<Socket | null>(null);
  const [socketConnected, setSocketConnected] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<QueuedFile[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadSpeed, setUploadSpeed] = useState('');
  const [selectedGif, setSelectedGif] = useState<GifItem | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [mentionMatches, setMentionMatches] = useState<Member[]>([]);
  const [mentionQuery, setMentionQuery] = useState<{ start: number; query: string } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [editing, setEditing] = useState<Message | null>(null);
  const [activePicker, setActivePicker] = useState<PickerMode>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [channelSettings, setChannelSettings] = useState<Channel | null>(null);
  const [channelSettingsBusy, setChannelSettingsBusy] = useState(false);
  const [channelMenu, setChannelMenu] = useState<ChannelMenuState | null>(null);
  const [channelAreaMenu, setChannelAreaMenu] = useState<ChannelAreaMenuState | null>(null);
  const [activeMessageMenuId, setActiveMessageMenuId] = useState<string | null>(null);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Set<string>>(new Set());
  const [mutedChannelIds, setMutedChannelIds] = useState<Set<string>>(readMutedChannelIds);
  const [unreadChannelIds, setUnreadChannelIds] = useState<Set<string>>(readUnreadChannelIds);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [serverName, setServerName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [channelName, setChannelName] = useState('');
  const [channelType, setChannelType] = useState<'text' | 'voice'>('text');
  const [channelCategoryId, setChannelCategoryId] = useState('');
  const [categoryName, setCategoryName] = useState('');
  const [topic, setTopic] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [search, setSearch] = useState('');
  const [gifSearch, setGifSearch] = useState('');
  const [gifs, setGifs] = useState<GifItem[]>([]);
  const [gifNext, setGifNext] = useState('');
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState('');
  const [showMembers, setShowMembers] = useState(true);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<string>>(new Set());
  const [voiceDuration, setVoiceDuration] = useState(0);
  const [mediaViewer, setMediaViewer] = useState<{ url: string; name: string; zoom: number } | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const savedTheme = localStorage.getItem('orbit.theme');
    return savedTheme === 'light' || savedTheme === 'system' ? savedTheme : 'dark';
  });
  const [systemPrefersLight, setSystemPrefersLight] = useState(false);
  const [fontScale, setFontScale] = useState(Number(localStorage.getItem('orbit.fontScale') ?? 100));
  const [desktopNotifications, setDesktopNotifications] = useState(localStorage.getItem('orbit.notifications') === 'on');
  const [reducedMotion, setReducedMotion] = useState(localStorage.getItem('orbit.reduceMotion') === 'on');
  const [voiceSounds, setVoiceSounds] = useState(localStorage.getItem('orbit.voiceSounds') !== 'off');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(localStorage.getItem('orbit.sidebarCollapsed') === 'on');
  const [voiceInputDeviceId, setVoiceInputDeviceId] = useState(localStorage.getItem('orbit.voiceInputDevice') ?? '');
  const [voiceOutputDeviceId, setVoiceOutputDeviceId] = useState(localStorage.getItem('orbit.voiceOutputDevice') ?? '');
  const [toast, setToast] = useState<ToastValue | null>(null);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [view, setView] = useState<'channel' | 'friends'>('channel');
  const [friends, setFriends] = useState<Array<{ id: string; requestId?: string | null; displayName: string; username: string; status: string; relation: 'friend' | 'incoming' | 'outgoing' }>>([]);
  const [friendQuery, setFriendQuery] = useState('');
  const [friendTab, setFriendTab] = useState<'online' | 'all' | 'pending' | 'add'>('online');
  const [activeDmId, setActiveDmId] = useState<string | null>(null);
  const [activeDmUser, setActiveDmUser] = useState<string | null>(null);
  const [activeDmUserId, setActiveDmUserId] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<Message[]>([]);
  const [isAtLatest, setIsAtLatest] = useState(true);
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const voiceSessionRef = useRef<{ channelId: string; startedAt: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const initialScrollGenerationRef = useRef(0);
  const loadingOlderMessagesRef = useRef(false);
  const olderMessagesGenerationRef = useRef(0);
  const dmLoadGenerationRef = useRef(0);
  const lastChannelMessageCount = useRef(0);
  const lastDmMessageCount = useRef(0);
  const prependScrollPosition = useRef<{ channelId: string; scrollHeight: number; scrollTop: number } | null>(null);
  const selectedServerRef = useRef<string | null>(null);
  const selectedChannelRef = useRef<string | null>(null);
  const activeDmRef = useRef<string | null>(null);
  const connectionStatusRef = useRef<ConnectionStatus>('checking');
  const desktopNotificationsRef = useRef(false);
  const mutedChannelIdsRef = useRef(mutedChannelIds);
  const voiceInputDeviceIdRef = useRef(voiceInputDeviceId);
  const voiceOutputDeviceIdRef = useRef(voiceOutputDeviceId);
  const toastCounter = useRef(0);
  const pendingSendsRef = useRef(new Map<string, PendingSend>());
  const sendingMessageIdsRef = useRef(new Set<string>());
  const typingStopTimerRef = useRef<number | null>(null);
  const typingActiveRef = useRef(false);
  const remoteTypingTimersRef = useRef(new Map<string, number>());
  const notifiedUpdateVersionRef = useRef<string | null>(localStorage.getItem('orbit.notifiedUpdateVersion'));
  selectedServerRef.current = selectedServerId;
  selectedChannelRef.current = selectedChannelId;
  activeDmRef.current = activeDmId;
  connectionStatusRef.current = connectionStatus;
  desktopNotificationsRef.current = desktopNotifications;
  mutedChannelIdsRef.current = mutedChannelIds;
  voiceInputDeviceIdRef.current = voiceInputDeviceId;
  voiceOutputDeviceIdRef.current = voiceOutputDeviceId;

  const notify = useCallback((text: string) => {
    const id = ++toastCounter.current;
    setToast({ id, text });
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3200);
  }, []);
  const stopTyping = useCallback(() => {
    if (typingStopTimerRef.current !== null) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = null;
    if (typingActiveRef.current) socket?.emit('typing:stop');
    typingActiveRef.current = false;
  }, [socket]);
  const reportTyping = useCallback((active: boolean) => {
    if (!active || !socket?.connected) { stopTyping(); return; }
    socket.emit('typing:start');
    typingActiveRef.current = true;
    if (typingStopTimerRef.current !== null) window.clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = window.setTimeout(stopTyping, 1800);
  }, [socket, stopTyping]);
  const updateLatestState = useCallback((element: HTMLElement) => {
    const isAtBottom = isNearLatest(element);
    atBottom.current = isAtBottom;
    setIsAtLatest((current) => current === isAtBottom ? current : isAtBottom);
  }, []);
  const scrollToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    atBottom.current = true; setIsAtLatest(true);
  }, []);
  const voice = useVoice(socket, apiUrl, token, user?.id ?? null, notify, voiceSounds, voiceInputDeviceId);
  const resolvedTheme = theme === 'system' ? systemPrefersLight ? 'light' : 'dark' : theme;
  const themeClass = resolvedTheme === 'light' ? 'theme-light' : '';
  const connectionLabel = connectionStatus === 'offline' ? 'Server unavailable'
    : connectionStatus === 'checking' ? 'Checking server…'
    : socketConnected ? 'Connected' : 'Server reachable';
  const connectionDotClass = connectionStatus === 'online' ? 'connected'
    : connectionStatus === 'offline' ? 'offline' : 'checking';

  const request = useCallback(<T,>(path: string, init: RequestInit = {}) => apiRequest<T>(apiUrl, token, path, init), [apiUrl, token]);
  avatarApiUrl = apiUrl;

  const activeServer = servers.find((server) => server.id === selectedServerId) ?? null;
  const activeChannel = activeServer?.channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const canManageServer = activeServer?.role === 'owner' || activeServer?.role === 'admin';
  const displayedMessages = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? messages.filter((message) => `${message.authorName} ${message.content}`.toLowerCase().includes(needle)) : messages;
  }, [messages, search]);

  const loadBootstrap = useCallback(async (base: string, sessionToken: string) => {
    const data = await apiRequest<Bootstrap>(base, sessionToken, '/api/bootstrap');
    setUser(data.user); setServers(data.servers);
    const preferredServerId = data.servers.some((server) => server.id === selectedServerRef.current) ? selectedServerRef.current : data.servers[0]?.id ?? null;
    setSelectedServerId(preferredServerId);
    const server = data.servers.find((item) => item.id === preferredServerId) ?? data.servers[0];
    const firstChannel = server?.channels.find((channel) => channel.type === 'text') ?? server?.channels[0];
    const preferredChannel = server?.channels.find((channel) => channel.id === selectedChannelRef.current) ?? firstChannel;
    setSelectedChannelId(preferredChannel?.id ?? null);
  }, []);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      let sessionKey = '';
      try {
        const info = await window.orbit.runtime();
        if (disposed) return;
        setRuntime(info);
        const savedServer = localStorage.getItem('orbit.serverUrl');
        const usesLocalWorkspace = !savedServer || savedServer === 'local';
        const base = usesLocalWorkspace ? info.localApiUrl : normalizeServerUrl(savedServer);
        sessionKey = usesLocalWorkspace ? 'local' : base;
        setApiUrl(base);
        const savedToken = await window.orbit.getSession(sessionKey);
        if (!savedToken || disposed) { setBusy(false); return; }
        setBootMessage('Verifying your saved session');
        setToken(savedToken);
        await apiRequest(base, savedToken, '/api/auth/me');
        await loadBootstrap(base, savedToken);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && sessionKey) {
          await window.orbit.saveSession(sessionKey, null).catch(() => false);
        }
        if (!disposed) {
          setToken(null);
          setUser(null);
          setAuthNotice(error instanceof ApiError && error.status === 401
            ? 'Your saved session has expired. Please sign in again.'
            : error instanceof Error ? error.message : 'Could not verify your saved session. Please sign in again.');
        }
      } finally {
        if (!disposed) setSessionCheckComplete(true);
      }
    })();
    return () => { disposed = true; };
  }, [loadBootstrap]);

  useEffect(() => {
    if (!runtime) return;
    let disposed = false;
    const checkForUpdate = async () => {
      try {
        const update = await window.orbit.updates.check();
        if (disposed) return;
        setAvailableUpdate(update);
        if (update && notifiedUpdateVersionRef.current !== update.version) {
          notifiedUpdateVersionRef.current = update.version;
          localStorage.setItem('orbit.notifiedUpdateVersion', update.version);
          notify(`Orbit Chat ${update.version} is available. Click the update icon to review and install it.`);
        }
      } catch {
        // Update checks are optional; do not interrupt startup when GitHub is unavailable.
      }
    };
    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [runtime?.version, notify]);

  useEffect(() => {
    let disposed = false;
    let refreshing = false;
    const refreshNetworkStatus = async () => {
      if (refreshing) return;
      refreshing = true;
        try { const info = await window.orbit.runtime(); if (!disposed) setRuntime(info); }
      catch { /* Keep the last known status visible if a refresh fails. */ }
      finally { refreshing = false; }
    };
    const timer = window.setInterval(() => void refreshNetworkStatus(), 20_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!apiUrl) {
      setConnectionStatus('checking');
      return;
    }

    let disposed = false;
    let inFlight = false;
    let unavailableSince: number | null = Date.now();
    let activeController: AbortController | null = null;
    let slowRequestTimer = 0;
    let requestTimeout = 0;

    const checkHealth = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const startedAt = Date.now();
      activeController = new AbortController();

      if (connectionStatusRef.current === 'online') {
        slowRequestTimer = window.setTimeout(() => {
          if (!disposed && inFlight) setConnectionStatus('checking');
        }, 900);
      }
      requestTimeout = window.setTimeout(() => activeController?.abort(), 30_000);

      try {
        const response = await fetch(`${apiUrl}/health`, {
          headers: { Accept: 'application/json' },
          mode: 'cors',
          cache: 'no-store',
          signal: activeController.signal,
        });
        if (!response.ok) throw new Error(`Health check failed with HTTP ${response.status}.`);
        const health = await response.json() as { ok?: unknown };
        if (health.ok !== true) throw new Error('The server did not confirm its health.');
        if (!disposed) {
          unavailableSince = null;
          setConnectionStatus('online');
        }
      } catch {
        if (!disposed) {
          unavailableSince ??= startedAt;
          setConnectionStatus(Date.now() - unavailableSince >= 30_000 ? 'offline' : 'checking');
        }
      } finally {
        window.clearTimeout(slowRequestTimer);
        window.clearTimeout(requestTimeout);
        activeController = null;
        inFlight = false;
      }
    };

    setConnectionStatus('checking');
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(slowRequestTimer);
      window.clearTimeout(requestTimeout);
      activeController?.abort();
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!user?.id || !token || !apiUrl) return;
    const connection = io(apiUrl, { auth: { token }, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 8000, timeout: 8000 });
    setSocket(connection);
    const clearTypingState = () => {
      for (const timer of remoteTypingTimersRef.current.values()) window.clearTimeout(timer);
      remoteTypingTimersRef.current.clear();
      setTypingUsers([]);
      if (typingStopTimerRef.current !== null) window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = null;
      typingActiveRef.current = false;
    };
    const onConnect = () => { setSocketConnected(true); if (selectedChannelRef.current) connection.emit('channel:join', selectedChannelRef.current); if (activeDmRef.current) connection.emit('dm:join', activeDmRef.current); };
    const onDisconnect = () => { setSocketConnected(false); clearTypingState(); };
    const onTypingUpdate = (payload: { room?: unknown; userId?: unknown; displayName?: unknown; typing?: unknown }) => {
      if (typeof payload.room !== 'string' || typeof payload.userId !== 'string' || typeof payload.displayName !== 'string' || typeof payload.typing !== 'boolean') return;
      if (!payload.room.startsWith('channel:') && !payload.room.startsWith('dm:')) return;
      const key = `${payload.room}\u001f${payload.userId}`;
      const previousTimer = remoteTypingTimersRef.current.get(key);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      remoteTypingTimersRef.current.delete(key);
      if (!payload.typing) {
        setTypingUsers((current) => current.filter((item) => item.room !== payload.room || item.userId !== payload.userId));
        return;
      }
      const typingUser = { room: payload.room, userId: payload.userId, displayName: payload.displayName };
      setTypingUsers((current) => [...current.filter((item) => item.room !== typingUser.room || item.userId !== typingUser.userId), typingUser]);
      remoteTypingTimersRef.current.set(key, window.setTimeout(() => {
        remoteTypingTimersRef.current.delete(key);
        setTypingUsers((current) => current.filter((item) => item.room !== typingUser.room || item.userId !== typingUser.userId));
      }, 3200));
    };
    const onNewMessage = (message: Message) => {
      if (message.channelId !== selectedChannelRef.current) return;
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      if (message.authorId !== user.id && !mutedChannelIdsRef.current.has(message.channelId) && desktopNotificationsRef.current && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification(`New message · ${message.authorName}`, { body: message.content.slice(0, 120) || 'Shared media', silent: true });
    };
    const onMention = ({ channelId, message }: { channelId: string; message: Message }) => {
      if (message.authorId === user.id || mutedChannelIdsRef.current.has(channelId)) return;
      if (channelId === selectedChannelRef.current && document.visibilityState === 'visible') notify(`${message.authorName} mentioned you.`);
      if (desktopNotificationsRef.current && Notification.permission === 'granted' && document.visibilityState !== 'visible') new Notification(`You were mentioned · ${message.authorName}`, { body: message.content.slice(0, 160) || 'You were mentioned in a shared file.', silent: false });
    };
    const onUpdated = (message: Message) => setMessages((current) => current.map((item) => item.id === message.id ? message : item));
    const onDeleted = ({ messageId }: { messageId: string }) => setMessages((current) => current.map((item) => item.id === messageId ? { ...item, content: 'This message was deleted.', deletedAt: new Date().toISOString() } : item));
    const onReaction = ({ messageId, reactions }: { messageId: string; reactions: Message['reactions'] }) => {
      setMessages((current) => current.map((item) => item.id === messageId ? { ...item, reactions } : item));
      setDmMessages((current) => current.map((item) => item.id === messageId ? { ...item, reactions } : item));
    };
    const onPresenceOnline = ({ userId }: { userId: string }) => setOnlineUserIds((current) => new Set(current).add(userId));
    const onPresenceOffline = ({ userId }: { userId: string }) => setOnlineUserIds((current) => { const next = new Set(current); next.delete(userId); return next; });
    const onPresenceSnapshot = (userIds: string[]) => setOnlineUserIds(new Set(Array.isArray(userIds) ? userIds : []));
    const onPresenceChanged = (updated: User) => {
      setMembers((current) => current.map((member) => member.id === updated.id ? { ...member, ...updated } : member));
      if (updated.id === user.id) setUser(updated);
      setMessages((current) => current.map((message) => message.authorId === updated.id ? { ...message, avatarUrl: updated.avatarUrl } : message));
      setDmMessages((current) => current.map((message) => message.authorId === updated.id ? { ...message, avatarUrl: updated.avatarUrl } : message));
    };
    const onChannelActivity = ({ channelId, authorId }: { channelId: string; authorId: string }) => { if (authorId !== user.id && channelId !== selectedChannelRef.current) setUnreadChannelIds((current) => new Set(current).add(channelId)); };
    const onChannelUpdated = (channel: Channel) => setServers((current) => current.map((server) => ({ ...server, channels: server.channels.map((item) => item.id === channel.id ? channel : item) })));
    const onChannelCreated = (channel: Channel) => setServers((current) => current.map((server) => server.id === channel.serverId && !server.channels.some((item) => item.id === channel.id) ? { ...server, channels: [...server.channels, channel].sort((a,b) => a.position-b.position) } : server));
    const onCategoryCreated = (category: Category) => setServers((current) => current.map((server) => server.id === category.serverId && !(server.categories ?? []).some((item) => item.id === category.id) ? { ...server, categories: [...(server.categories ?? []), category].sort((a,b) => a.position-b.position) } : server));
    const onChannelDeleted = ({ channelId }: { channelId: string }) => { setServers((current) => current.map((server) => ({ ...server, channels: server.channels.filter((channel) => channel.id !== channelId) }))); setUnreadChannelIds((current) => { const next = new Set(current); next.delete(channelId); return next; }); if (selectedChannelRef.current === channelId) { setSelectedChannelId(null); setMessages([]); } };
    const onServerEvent = () => { void loadBootstrap(apiUrl, token); };
    const onDmMessage = (message: Message) => { if (message.conversationId === activeDmRef.current) setDmMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]); };
    const onDmUpdated = (message: Message) => setDmMessages((current) => current.map((item) => item.id === message.id ? message : item));
    const onDmDeleted = ({ messageId }: { messageId: string }) => setDmMessages((current) => current.map((item) => item.id === messageId ? { ...item, content: 'This message was deleted.', deletedAt: new Date().toISOString() } : item));
    connection.on('connect', onConnect); connection.on('disconnect', onDisconnect);
    connection.on('typing:update', onTypingUpdate);
    connection.on('message:new', onNewMessage); connection.on('message:updated', onUpdated); connection.on('message:deleted', onDeleted); connection.on('message:mention', onMention); connection.on('reaction:updated', onReaction);
    connection.on('presence:online', onPresenceOnline); connection.on('presence:offline', onPresenceOffline); connection.on('presence:snapshot', onPresenceSnapshot); connection.on('presence:changed', onPresenceChanged);
    connection.on('message:activity', onChannelActivity);
    connection.on('channel:updated', onChannelUpdated); connection.on('channel:created', onChannelCreated); connection.on('channel:deleted', onChannelDeleted); connection.on('category:created', onCategoryCreated);
    connection.on('server:created', onServerEvent); connection.on('server:joined', onServerEvent); connection.on('friend:request', () => { void loadFriends(apiUrl, token); }); connection.on('friend:changed', () => { void loadFriends(apiUrl, token); });
    connection.on('dm:message', onDmMessage); connection.on('dm:updated', onDmUpdated); connection.on('dm:deleted', onDmDeleted);
    const loadFriends = async (base: string, session: string) => { try { const result = await apiRequest<{ friends: typeof friends }>(base, session, '/api/friends'); setFriends(result.friends); } catch { /* friendship panel reports request errors when opened */ } };
    void loadFriends(apiUrl, token);
    return () => { clearTypingState(); connection.disconnect(); setSocket((current) => current === connection ? null : current); };
  }, [user?.id, token, apiUrl, loadBootstrap, notify]);

  useEffect(() => {
    if (!socket || !selectedChannelId || !token || !apiUrl) return;
    const channelId = selectedChannelId;
    const scrollGeneration = ++initialScrollGenerationRef.current;
    olderMessagesGenerationRef.current++;
    loadingOlderMessagesRef.current = false;
    prependScrollPosition.current = null;
    socket.emit('channel:join', channelId);
    setLoadingMessages(true); atBottom.current = true; setIsAtLatest(true);
    void apiRequest<{ messages: Message[]; hasMore: boolean }>(apiUrl, token, `/api/channels/${channelId}/messages`)
      .then((result) => {
        if (initialScrollGenerationRef.current !== scrollGeneration || selectedChannelRef.current !== channelId) return;
        setMessages(result.messages); setHasMore(result.hasMore); lastChannelMessageCount.current = result.messages.length;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (initialScrollGenerationRef.current === scrollGeneration && selectedChannelRef.current === channelId)
            scrollToLatest();
        }));
      })
      .catch((error) => { if (initialScrollGenerationRef.current === scrollGeneration) notify(error instanceof Error ? error.message : 'Could not load channel messages.'); })
      .finally(() => { if (initialScrollGenerationRef.current === scrollGeneration) setLoadingMessages(false); });
    return () => { initialScrollGenerationRef.current++; };
  }, [socket, selectedChannelId, token, apiUrl, notify, scrollToLatest]);

  useEffect(() => {
    if (showMembers && activeServer && token && apiUrl) void apiRequest<{ members: Member[] }>(apiUrl, token, `/api/servers/${activeServer.id}/members`).then((result) => setMembers(result.members)).catch(() => undefined);
  }, [showMembers, activeServer?.id, token, apiUrl]);

  useEffect(() => { setActiveMessageMenuId(null); }, [selectedChannelId, activeDmId]);

  useEffect(() => {
    const updateProfile = (event: Event) => setUser((event as CustomEvent<User>).detail);
    window.addEventListener('orbit:profile', updateProfile);
    return () => window.removeEventListener('orbit:profile', updateProfile);
  }, []);

  useEffect(() => {
    if (messages.length > lastChannelMessageCount.current && atBottom.current) scrollToLatest();
    lastChannelMessageCount.current = messages.length;
  }, [messages, scrollToLatest]);

  useEffect(() => {
    const loadGeneration = ++dmLoadGenerationRef.current;
    if (!activeDmId || !token || !apiUrl) return;
    const conversationId = activeDmId;
    socket?.emit('dm:join', conversationId);
    atBottom.current = true; setIsAtLatest(true);
    void apiRequest<{ messages: Message[] }>(apiUrl, token, `/api/dms/${conversationId}/messages`).then((result) => {
      if (dmLoadGenerationRef.current !== loadGeneration || activeDmRef.current !== conversationId) return;
      setDmMessages(result.messages); lastDmMessageCount.current = result.messages.length;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (activeDmRef.current === conversationId) scrollToLatest();
      }));
    }).catch((error) => { if (dmLoadGenerationRef.current === loadGeneration) notify(error instanceof Error ? error.message : 'Could not load conversation.'); });
    return () => { if (dmLoadGenerationRef.current === loadGeneration) dmLoadGenerationRef.current++; };
  }, [activeDmId, token, apiUrl, socket, notify, scrollToLatest]);

  useEffect(() => { if (dmMessages.length > lastDmMessageCount.current && atBottom.current) scrollToLatest(); lastDmMessageCount.current = dmMessages.length; }, [dmMessages, scrollToLatest]);

  useEffect(() => {
    if (activePicker !== 'gif' || !apiUrl || !token) return;
    const timer = window.setTimeout(() => {
      setGifLoading(true); setGifError(''); setGifNext(''); setGifs([]);
      const query = gifSearch.trim() ? `?q=${encodeURIComponent(gifSearch.trim())}` : '';
      void apiRequest<{ results: GifItem[]; next: string }>(apiUrl, token, `/api/integrations/tenor/search${query}`)
        .then((result) => { setGifs(result.results); setGifNext(result.next); })
        .catch((error) => { setGifs([]); setGifError(error instanceof Error ? error.message : 'GIF search is unavailable.'); })
        .finally(() => setGifLoading(false));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [activePicker, gifSearch, apiUrl, token]);

  const loadMoreGifs = async () => {
    if (!gifNext || gifLoading) return;
    const query = new URLSearchParams();
    if (gifSearch.trim()) query.set('q', gifSearch.trim());
    query.set('pos', gifNext);
    setGifLoading(true);
    try { const result = await request<{ results: GifItem[]; next: string }>(`/api/integrations/tenor/search?${query.toString()}`); setGifs((current) => [...current, ...result.results]); setGifNext(result.next); }
    catch (error) { setGifError(error instanceof Error ? error.message : 'More GIFs could not be loaded.'); }
    finally { setGifLoading(false); }
  };

  useEffect(() => {
    if (!activePicker) return;
    const onPointer = (event: PointerEvent) => { if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setActivePicker(null); };
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') { setActivePicker(null); textareaRef.current?.focus(); } };
    document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [activePicker]);

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', `${fontScale / 100}`);
    localStorage.setItem('orbit.theme', theme); localStorage.setItem('orbit.fontScale', String(fontScale));
    localStorage.setItem('orbit.notifications', desktopNotifications ? 'on' : 'off'); localStorage.setItem('orbit.reduceMotion', reducedMotion ? 'on' : 'off');
    localStorage.setItem('orbit.voiceSounds', voiceSounds ? 'on' : 'off');
    localStorage.setItem('orbit.sidebarCollapsed', sidebarCollapsed ? 'on' : 'off');
  }, [theme, fontScale, desktopNotifications, reducedMotion, voiceSounds, sidebarCollapsed]);

  useEffect(() => {
    localStorage.removeItem('orbit.easterEggs');
    localStorage.removeItem('orbit.cosmicThemeUnlocked');
  }, []);

  useEffect(() => {
    localStorage.setItem('orbit.mutedChannels', JSON.stringify([...mutedChannelIds]));
  }, [mutedChannelIds]);

  useEffect(() => {
    localStorage.setItem('orbit.unreadChannels', JSON.stringify([...unreadChannelIds]));
  }, [unreadChannelIds]);

  useEffect(() => {
    if (!servers.length) return;
    const readableChannelIds = new Set(servers.flatMap((server) => server.channels.filter((channel) => channel.type !== 'voice').map((channel) => channel.id)));
    setUnreadChannelIds((current) => {
      const next = new Set([...current].filter((channelId) => readableChannelIds.has(channelId)));
      return next.size === current.size ? current : next;
    });
  }, [servers]);

  useEffect(() => {
    if (!selectedChannelId) return;
    setUnreadChannelIds((current) => {
      if (!current.has(selectedChannelId)) return current;
      const next = new Set(current); next.delete(selectedChannelId); return next;
    });
  }, [selectedChannelId]);

  useEffect(() => {
    const voiceChannelIds = new Set(servers.flatMap((server) => server.channels.filter((channel) => channel.type === 'voice').map((channel) => channel.id)));
    if (!voiceChannelIds.size) return;
    setMutedChannelIds((current) => {
      const next = new Set([...current].filter((channelId) => !voiceChannelIds.has(channelId)));
      return next.size === current.size ? current : next;
    });
  }, [servers]);

  useEffect(() => {
    if (!channelMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.channel-action-menu, .channel-more')) return;
      setChannelMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setChannelMenu(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [channelMenu]);

  useEffect(() => {
    if (!channelAreaMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.channel-area-menu')) return;
      setChannelAreaMenu(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setChannelAreaMenu(null); };
    document.addEventListener('pointerdown', onPointerDown); document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown); };
  }, [channelAreaMenu]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: light)');
    setSystemPrefersLight(preference.matches);
    const change = (event: MediaQueryListEvent) => setSystemPrefersLight(event.matches);
    preference.addEventListener('change', change);
    return () => preference.removeEventListener('change', change);
  }, []);

  useEffect(() => {
    if (dialog !== 'settings' || !navigator.mediaDevices?.enumerateDevices) return;
    let active = true;
    let refreshing = false;
    let refreshPending = false;
    const refresh = async (requestPermission = false) => {
      if (refreshing) { refreshPending = true; return; }
      refreshing = true;
      try {
        if (requestPermission && navigator.mediaDevices.getUserMedia) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            stream.getTracks().forEach((track) => track.stop());
          } catch { /* Show whatever devices the OS allows without microphone permission. */ }
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!active) return;
        const audio = uniqueSelectableAudioDevices(devices);
        setAudioDevices(audio);
        const inputIds = audio.filter((device) => device.kind === 'audioinput').map((device) => device.deviceId);
        const outputIds = audio.filter((device) => device.kind === 'audiooutput').map((device) => device.deviceId);
        if (voiceInputDeviceIdRef.current && !inputIds.includes(voiceInputDeviceIdRef.current)) setVoiceInputDeviceId('');
        if (voiceOutputDeviceIdRef.current && !outputIds.includes(voiceOutputDeviceIdRef.current)) setVoiceOutputDeviceId('');
      } catch { if (active) setAudioDevices([]); }
      finally {
        refreshing = false;
        if (active && refreshPending) { refreshPending = false; void refresh(false); }
      }
    };
    void refresh(true);
    const onDeviceChange = () => { void refresh(false); };
    navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    return () => { active = false; navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange); };
  }, [dialog]);

  useEffect(() => {
    localStorage.setItem('orbit.voiceInputDevice', voiceInputDeviceId);
    localStorage.setItem('orbit.voiceOutputDevice', voiceOutputDeviceId);
  }, [voiceInputDeviceId, voiceOutputDeviceId]);

  useEffect(() => {
    const current = voice.voice;
    if (!current) { voiceSessionRef.current = null; setSpeakingUserIds(new Set()); setVoiceDuration(0); return; }
    if (voiceSessionRef.current?.channelId !== current.channelId) voiceSessionRef.current = { channelId: current.channelId, startedAt: performance.now() };
    const startedAt = voiceSessionRef.current.startedAt;
    const audioContext = new AudioContext();
    void audioContext.resume().catch(() => undefined);
    const sources = new Map<string, { analyser: AnalyserNode; samples: Uint8Array<ArrayBuffer> }>();
    const attach = (id: string, stream: MediaStream) => {
      if (sources.has(id)) return;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      sources.set(id, { analyser, samples: new Uint8Array(analyser.fftSize) });
    };
    attach(user?.id ?? 'self', current.stream);
    for (const [peerId, stream] of Object.entries(current.remoteStreams)) attach(peerId, stream);
    const lastSpeakingAt = new Map<string, number>();
    const sample = () => {
      const speaking = new Set<string>();
      sources.forEach(({ analyser, samples }, id) => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + (value - 128) ** 2, 0) / samples.length);
        if (rms > 5 && (id !== (user?.id ?? 'self') || !current.muted)) lastSpeakingAt.set(id, Date.now());
        if ((lastSpeakingAt.get(id) ?? 0) > Date.now() - 260 && (id !== (user?.id ?? 'self') || !current.muted)) speaking.add(id);
      });
      setSpeakingUserIds(speaking);
      setVoiceDuration(Math.floor((Date.now() - startedAt) / 1000));
    };
    const timer = window.setInterval(sample, 120);
    sample();
    return () => { window.clearInterval(timer); void audioContext.close(); };
  }, [voice.voice?.channelId, voice.voice?.stream, voice.voice?.remoteStreams, voice.voice?.muted, user?.id]);

  const reloadBootstrap = async () => { if (apiUrl && token) await loadBootstrap(apiUrl, token); };
  const updateMentionSuggestions = (value: string, caret: number) => {
    if (view !== 'channel' || !activeServer || editing || !activeChannel || activeChannel.type === 'voice') {
      setMentionQuery(null); setMentionMatches([]); return;
    }
    const query = mentionQueryAtCaret(value, caret);
    const matches = query ? findMentionMatches(query.query, members, user?.id) : [];
    setActiveMentionIndex(0);
    setMentionQuery(matches.length && query ? query : null);
    setMentionMatches(matches);
  };

  const chooseMention = (member: Member) => {
    const textarea = textareaRef.current;
    if (!textarea || !mentionQuery) return;
    const inserted = insertMention(draft, textarea.selectionStart, mentionQuery.start, member);
    setDraft(inserted.value);
    setMentionQuery(null); setMentionMatches([]); setActiveMentionIndex(0);
    requestAnimationFrame(() => { textarea.focus(); textarea.setSelectionRange(inserted.caret, inserted.caret); textarea.style.height = 'auto'; textarea.style.height = `${Math.min(168, textarea.scrollHeight)}px`; });
  };

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault(); setAuthError(''); setAuthNotice(''); setAuthBusy(true);
    try {
      const savedServer = localStorage.getItem('orbit.serverUrl');
      const usesLocalWorkspace = !savedServer || savedServer === 'local';
      const base = usesLocalWorkspace ? runtime?.localApiUrl ?? apiUrl : normalizeServerUrl(savedServer);
      const sessionKey = usesLocalWorkspace ? 'local' : base;
      setApiUrl(base); localStorage.setItem('orbit.serverUrl', usesLocalWorkspace ? 'local' : base);
      const endpoint = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const result = await apiRequest<{ sessionToken: string; user: User }>(base, null, endpoint, { method: 'POST', body: JSON.stringify({ username, password, ...(authMode === 'register' ? { displayName: displayName || username } : {}) }) });
      await loadBootstrap(base, result.sessionToken);
      await window.orbit.saveSession(sessionKey, result.sessionToken);
      setToken(result.sessionToken); setPassword('');
      setAuthNotice(runtime?.encryptionAvailable ? '' : 'This Windows profile does not support encrypted session storage. Sign in again after restarting.');
    } catch (error) { setAuthError(error instanceof Error ? error.message : 'Unable to sign in right now.'); }
    finally { setAuthBusy(false); }
  };

  const signOut = async () => {
    if (token) { try { await apiRequest(apiUrl, token, '/api/auth/logout', { method: 'POST' }); } catch { /* clear the local credential even if the server is offline */ } }
    await window.orbit.saveSession(apiUrl === runtime?.localApiUrl ? 'local' : apiUrl, null);
    voice.leave(); socket?.disconnect(); setSocket(null); setToken(null); setUser(null); setServers([]); setMessages([]); setAttachments([]); setSelectedChannelId(null); setSelectedServerId(null); setActiveDmId(null); setActiveDmUser(null); setActiveDmUserId(null); setDialog(null);
  };

  const launchUpdater = async () => {
    if (!availableUpdate || updaterLaunching) return;
    setUpdaterLaunching(true);
    try {
      await window.orbit.updates.start();
    } catch (error) {
      setUpdaterLaunching(false);
      notify(error instanceof Error ? error.message : 'The Orbit Chat updater could not be opened.');
    }
  };

  const createServer = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { const result = await request<{ server: Server; inviteCode: string }>('/api/servers', { method: 'POST', body: JSON.stringify({ name: serverName }) }); setServerName(''); setDialog(null); await loadBootstrap(apiUrl, token!); setSelectedServerId(result.server.id); setSelectedChannelId(result.server.channels.find((channel) => channel.type === 'text')?.id ?? null); setInviteLink(result.inviteCode); notify('Server created.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Server could not be created.'); } finally { setBusy(false); }
  };

  const joinServer = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try { await request('/api/servers/join', { method: 'POST', body: JSON.stringify({ inviteCode: inviteCode.trim() }) }); setInviteCode(''); setDialog(null); await reloadBootstrap(); notify('You joined the server.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not use that invite.'); } finally { setBusy(false); }
  };

  const openCreateChannel = (type: 'text' | 'voice', categoryId = '') => {
    setChannelType(type); setChannelCategoryId(categoryId); setChannelName(''); setTopic(''); setChannelAreaMenu(null); setDialog('channel');
  };

  const createChannel = async (event: FormEvent) => {
    event.preventDefault(); if (!activeServer) return; setBusy(true);
    try { const result = await request<{ channel: Channel }>(`/api/servers/${activeServer.id}/channels`, { method: 'POST', body: JSON.stringify({ name: channelName.toLowerCase().replace(/\s+/g, '-'), type: channelType, topic, ...(channelCategoryId ? { categoryId: channelCategoryId } : {}) }) }); setDialog(null); setChannelName(''); setTopic(''); setChannelCategoryId(''); setSelectedChannelId(result.channel.id); if (result.channel.categoryId) setCollapsedCategoryIds((current) => { const next = new Set(current); next.delete(result.channel.categoryId!); return next; }); notify(`${channelType === 'voice' ? 'Voice' : 'Text'} channel created.`); }
    catch (error) { notify(error instanceof Error ? error.message : 'Channel could not be created.'); } finally { setBusy(false); }
  };

  const createCategory = async (event: FormEvent) => {
    event.preventDefault(); if (!activeServer) return; setBusy(true);
    try {
      const result = await request<{ category: Category }>(`/api/servers/${activeServer.id}/categories`, { method: 'POST', body: JSON.stringify({ name: categoryName.trim() }) });
      setServers((current) => current.map((server) => server.id === result.category.serverId ? { ...server, categories: [...(server.categories ?? []).filter((item) => item.id !== result.category.id), result.category].sort((a,b) => a.position-b.position) } : server));
      setCategoryName(''); setDialog(null); notify(`Category “${result.category.name}” created.`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Category could not be created.'); }
    finally { setBusy(false); }
  };

  const deleteChannel = (channel: Channel) => { setChannelMenu(null); setConfirmAction({ kind: 'channel', channel }); };

  const placeChannelMenu = (channel: Channel, anchor: { left: number; right: number; top: number; bottom: number }, atPointer = false) => {
    const width = Math.min(228, Math.max(180, window.innerWidth - 16));
    const canManage = Boolean(canManageServer);
    const canDelete = (activeServer?.channels.length ?? 0) > 1;
    const height = canManage ? channel.type === 'voice' ? 190 : 265 : channel.type === 'voice' ? 72 : 155;
    const left = Math.max(8, Math.min(atPointer ? anchor.left : anchor.right - width, window.innerWidth - width - 8));
    const maxTop = Math.max(42, window.innerHeight - height - 8);
    const below = atPointer ? anchor.top : anchor.bottom + 6;
    const top = Math.max(42, Math.min(below + height <= window.innerHeight - 8 ? below : (atPointer ? anchor.top - height : anchor.top - height - 6), maxTop));
    setChannelMenu({ channel, left, top, canManage, canDelete });
  };

  const openChannelMenu = (event: MouseEvent<HTMLButtonElement>, channel: Channel) => {
    event.preventDefault(); event.stopPropagation(); setChannelAreaMenu(null);
    const rect = event.currentTarget.getBoundingClientRect();
    placeChannelMenu(channel, rect);
  };

  const openChannelContextMenu = (event: MouseEvent<HTMLDivElement>, channel: Channel) => {
    event.preventDefault(); event.stopPropagation(); setChannelAreaMenu(null);
    if (channel.type === 'voice' && !canManageServer) return;
    placeChannelMenu(channel, { left: event.clientX, right: event.clientX, top: event.clientY, bottom: event.clientY }, true);
  };

  const openChannelAreaMenu = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target;
    const row = target instanceof Element ? target.closest<HTMLElement>('[data-channel-id]') : null;
    const rowChannel = row?.dataset.channelId ? activeServer?.channels.find((channel) => channel.id === row.dataset.channelId) : null;
    if (rowChannel) { openChannelContextMenu(event, rowChannel); return; }
    if (!canManageServer) return;
    const categoryElement = target instanceof Element ? target.closest<HTMLElement>('[data-category-id]') : null;
    const width = Math.min(236, window.innerWidth - 16);
    const height = 196;
    const left = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8));
    const top = Math.max(42, Math.min(event.clientY, window.innerHeight - height - 8));
    setChannelMenu(null);
    setChannelAreaMenu({ left, top, categoryId: categoryElement?.dataset.categoryId ?? null });
  };

  const toggleChannelMute = (channel: Channel) => {
    const isMuted = mutedChannelIds.has(channel.id);
    setMutedChannelIds((current) => {
      const next = new Set(current);
      if (next.has(channel.id)) next.delete(channel.id); else next.add(channel.id);
      return next;
    });
    notify(`${isMuted ? 'Unmuted' : 'Muted'} #${channel.name}.`);
  };

  const markChannelRead = (channel: Channel) => {
    setUnreadChannelIds((current) => {
      if (!current.has(channel.id)) return current;
      const next = new Set(current); next.delete(channel.id); return next;
    });
    setChannelMenu(null);
    notify(`#${channel.name} marked as read.`);
  };

  const duplicateChannel = async (channel: Channel) => {
    if (!canManageServer || !activeServer) return;
    setChannelMenu(null);
    const usedNames = new Set(activeServer.channels.map((item) => item.name.toLowerCase()));
    let name = `${channel.name.slice(0, 59)}-copy`;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) {
      const ending = `-copy-${suffix++}`;
      name = `${channel.name.slice(0, 64 - ending.length)}${ending}`;
    }
    try {
      const result = await request<{ channel: Channel }>(`/api/servers/${channel.serverId}/channels`, { method: 'POST', body: JSON.stringify({ name, type: channel.type, topic: channel.topic, ...(channel.categoryId ? { categoryId: channel.categoryId } : {}) }) });
      setServers((current) => current.map((server) => server.id === channel.serverId && !server.channels.some((item) => item.id === result.channel.id) ? { ...server, channels: [...server.channels, result.channel].sort((a,b) => a.position-b.position) } : server));
      if (result.channel.categoryId) setCollapsedCategoryIds((current) => { const next = new Set(current); next.delete(result.channel.categoryId!); return next; });
      notify(`Created #${result.channel.name}.`);
    } catch (error) { notify(error instanceof Error ? error.message : 'Channel could not be duplicated.'); }
  };

  const saveChannelSettings = async (event: FormEvent, channel: Channel, name: string, channelTopic: string) => {
    event.preventDefault();
    if (channelSettingsBusy) return;
    setChannelSettingsBusy(true);
    try {
      const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');
      const result = await request<{ channel: Channel }>(`/api/channels/${channel.id}`, { method: 'PATCH', body: JSON.stringify({ name: normalizedName, topic: channelTopic.trim() }) });
      setServers((current) => current.map((server) => ({ ...server, channels: server.channels.map((item) => item.id === channel.id ? result.channel : item) })));
      setChannelSettings(null);
      notify('Channel settings saved.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Channel settings could not be saved.'); }
    finally { setChannelSettingsBusy(false); }
  };

  const createInvite = async () => {
    if (!activeServer) return;
    try { const result = await request<{ code: string }>(`/api/servers/${activeServer.id}/invites`, { method: 'POST', body: JSON.stringify({}) }); setInviteLink(result.code); setDialog('invite'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Invite could not be created.'); }
  };

  const loadMembers = async () => {
    if (!activeServer) return;
    try { const result = await request<{ members: Member[] }>(`/api/servers/${activeServer.id}/members`); setMembers(result.members); }
    catch (error) { notify(error instanceof Error ? error.message : 'Member list could not be loaded.'); }
  };

  const changeServer = (server: Server) => {
    stopTyping();
    setView('channel'); setSelectedServerId(server.id); setActiveDmId(null); setActiveDmUser(null); setActiveDmUserId(null); setDmMessages([]); setDraft(''); setAttachments([]); setReplyTo(null); setEditing(null);
    const channel = server.channels.find((item) => item.type === 'text') ?? server.channels[0];
    setSelectedChannelId(channel?.id ?? null); setMessages([]);
  };

  const changeChannel = (channel: Channel) => {
    stopTyping();
    setView('channel'); setActiveDmId(null); setSelectedChannelId(channel.id); setMessages([]); setDraft(''); setAttachments([]); setReplyTo(null); setEditing(null);
    if (channel.type === 'voice') void voice.join(channel.id);
  };

  const addFiles = async (files: FileList | File[]) => {
    if (!files.length) return;
    const batch = Array.from(files);
    if (attachments.length + batch.length > 10) { notify('You can attach up to 10 files per message.'); return; }
    if (batch.some((file) => file.size > 20 * 1024 * 1024 * 1024)) { notify('Each file must be 20 GB or smaller.'); return; }
    const alreadySelectedBytes = attachments.reduce((sum, item) => sum + item.file.size, 0);
    if (alreadySelectedBytes + batch.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024 * 1024) { notify('Files in one upload may not exceed 20 GB combined.'); return; }
    setAttachments((current) => [...current, ...batch.map((file) => ({ id: crypto.randomUUID(), file }))]);
    setActivePicker(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const upsertMessage = (message: Message) => setMessages((current) => current.some((item) => item.id === message.id) ? current.map((item) => item.id === message.id ? message : item) : [...current, message]);
  const sendMessage = async () => {
    if (!activeChannel || (!draft.trim() && !attachments.length && !selectedGif && !editing) || busy) return;
    stopTyping();
    if (!editing && !attachments.length && !selectedGif) {
      const response = unknownSlashCommandMessage(draft);
      if (response) { setDraft(''); setReplyTo(null); notify(response); return; }
    }
    if (editing) {
      setBusy(true);
      try { const result = await request<{ message: Message }>(`/api/messages/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ content: draft.trim() }) }); upsertMessage(result.message); setEditing(null); setDraft(''); notify('Message updated.'); }
      catch (error) { notify(error instanceof Error ? error.message : 'Message could not be updated.'); }
      finally { setBusy(false); }
      return;
    }
    const id = crypto.randomUUID();
    const files = attachments.map((item) => item.file);
    const content = draft.trim();
    const body: ChannelMessagePayload = {
      content, kind: selectedGif ? 'gif' : 'text', ...(selectedGif ? { mediaUrl: selectedGif.url } : {}),
      ...(replyTo ? { replyToId: replyTo.id } : {}), attachmentIds: [],
      mentions: activeServer ? mentionedMemberIds(content, members, user?.id) : []
    };
    const pending: PendingSend = { payload: body, files, channelId: activeChannel.id, ...(selectedGif ? { gif: selectedGif, gifQuery: gifSearch } : {}) };
    pendingSendsRef.current.set(id, pending);
    const pendingMessage: Message = {
      id, channelId: activeChannel.id, authorId: user!.id, authorName: user!.displayName, avatarUrl: user!.avatarUrl,
      content, mentions: [], kind: body.kind, stickerEmoji: null, mediaUrl: body.mediaUrl ?? null,
      replyToId: body.replyToId ?? null, editedAt: null, deletedAt: null, createdAt: new Date().toISOString(),
      attachments: [], reactions: [], deliveryState: 'sending', uploadProgress: files.length ? 0 : undefined,
      pendingFiles: files.map((file) => ({ name: file.name, size: file.size }))
    };
    setMessages((current) => [...current, pendingMessage]);
    atBottom.current = true; setIsAtLatest(true);
    setDraft(''); setAttachments([]); setReplyTo(null); setSelectedGif(null); setActivePicker(null); setMentionQuery(null); setMentionMatches([]);
    await deliverPendingMessage(id);
  };

  const retryPendingMessage = (id: string) => { void deliverPendingMessage(id); };

  const cancelPendingMessage = (id: string) => {
    const pending = pendingSendsRef.current.get(id);
    if (!pending) return;
    pending.abortController?.abort();
    pendingSendsRef.current.delete(id);
    sendingMessageIdsRef.current.delete(id);
    setMessages((current) => current.filter((message) => message.id !== id));
    setDmMessages((current) => current.filter((message) => message.id !== id));
    setUploadProgress(null); setUploadSpeed('');
    notify('Message canceled.');
  };

  const updatePendingMessage = (id: string, update: (message: Message) => Message) => {
    setMessages((current) => current.map((message) => message.id === id ? update(message) : message));
    setDmMessages((current) => current.map((message) => message.id === id ? update(message) : message));
  };

  const deliverPendingMessage = async (id: string) => {
    const pending = pendingSendsRef.current.get(id);
    if (!pending || sendingMessageIdsRef.current.has(id)) return;
    sendingMessageIdsRef.current.add(id);
    pending.abortController = new AbortController();
    setBusy(true);
    setUploadProgress(pending.files.length ? 0 : null);
    setUploadSpeed('');
    updatePendingMessage(id, (message) => ({ ...message, deliveryState: 'sending', uploading: pending.files.length > 0, uploadProgress: pending.files.length ? 0 : undefined }));
    try {
      if (pending.files.length && !pending.uploaded) {
        pending.uploaded = (await uploadAttachmentsWithProgress(apiUrl, token!, pending.files, ({ percent, bytesPerSecond }) => {
          const speed = formatTransferRate(bytesPerSecond);
          setUploadProgress(percent); setUploadSpeed(speed);
          updatePendingMessage(id, (message) => ({ ...message, uploadProgress: percent, uploadSpeed: speed }));
        }, pending.abortController.signal)).attachments;
      }
      if (pendingSendsRef.current.get(id) !== pending) return;
      updatePendingMessage(id, (message) => ({ ...message, uploading: false }));
      pending.payload.attachmentIds = pending.uploaded?.map((attachment) => attachment.id) ?? [];
      const endpoint = pending.conversationId
        ? `/api/dms/${pending.conversationId}/messages`
        : `/api/channels/${pending.channelId}/messages`;
      const result = await request<{ message: Message }>(endpoint, { method: 'POST', body: JSON.stringify(pending.payload) });
      pendingSendsRef.current.delete(id);
      setMessages((current) => current.filter((message) => message.id !== id));
      if (pending.conversationId) setDmMessages((current) => [...current.filter((message) => message.id !== id && message.id !== result.message.id), result.message]);
      else if (selectedChannelRef.current === pending.channelId) upsertMessage(result.message);
      if (pending.payload.kind === 'gif' && pending.gif) void request('/api/integrations/tenor/share', { method: 'POST', body: JSON.stringify({ gifId: pending.gif.id, query: pending.gifQuery ?? '' }) }).catch(() => undefined);
       setUploadProgress(null); setUploadSpeed(''); setActivePicker(null); setMentionQuery(null); setMentionMatches([]); atBottom.current = true; setIsAtLatest(true);
    } catch (error) {
      if (pendingSendsRef.current.get(id) === pending) {
        updatePendingMessage(id, (message) => ({ ...message, deliveryState: 'failed', uploading: false, uploadProgress: undefined, uploadSpeed: undefined }));
        notify(error instanceof Error ? error.message : 'Message was not sent. Use Retry on the failed message.');
      }
    } finally {
      sendingMessageIdsRef.current.delete(id);
      if (!sendingMessageIdsRef.current.size) { setBusy(false); setUploadProgress(null); setUploadSpeed(''); }
    }
  };

  const sendSticker = async (sticker: typeof stickers[number]) => {
    if (!activeChannel) { notify('Choose a text channel before sending a sticker.'); return; }
    try { const result = await request<{ message: Message }>(`/api/channels/${activeChannel.id}/messages`, { method: 'POST', body: JSON.stringify({ content: '', kind: 'sticker', stickerEmoji: sticker.emoji }) }); upsertMessage(result.message); setActivePicker(null); }
    catch (error) { notify(error instanceof Error ? error.message : 'Sticker was not sent.'); }
  };

  const toggleReaction = async (message: Message, emoji: string) => {
    try { const result = await request<{ messageId: string; reactions: Message['reactions'] }>(`/api/messages/${message.id}/reactions`, { method: 'POST', body: JSON.stringify({ emoji }) }); setMessages((current) => current.map((item) => item.id === message.id ? { ...item, reactions: result.reactions } : item)); setDmMessages((current) => current.map((item) => item.id === message.id ? { ...item, reactions: result.reactions } : item)); }
    catch (error) { notify(error instanceof Error ? error.message : 'Reaction could not be added.'); }
  };

  const removeMessage = (message: Message) => setConfirmAction({ kind: 'message', message });

  const confirmDelete = async () => {
    const action = confirmAction;
    if (!action || confirmBusy) return;
    setConfirmBusy(true);
    try {
      if (action.kind === 'message') {
        await request(`/api/messages/${action.message.id}`, { method: 'DELETE' });
        const deleted = { ...action.message, content: 'This message was deleted.', deletedAt: new Date().toISOString() };
        setMessages((current) => current.map((item) => item.id === deleted.id ? deleted : item));
        setDmMessages((current) => current.map((item) => item.id === deleted.id ? deleted : item));
      } else {
        const channel = action.channel;
        await request(`/api/channels/${channel.id}`, { method: 'DELETE' });
        setServers((current) => current.map((server) => ({ ...server, channels: server.channels.filter((item) => item.id !== channel.id) })));
        if (selectedChannelId === channel.id) { setSelectedChannelId(null); setMessages([]); }
      }
      setConfirmAction(null);
    } catch (error) {
      notify(error instanceof Error ? error.message : action.kind === 'message' ? 'Message could not be deleted.' : 'Channel could not be deleted.');
    } finally { setConfirmBusy(false); }
  };

  const reportMessage = async (message: Message) => {
    const reason = window.prompt('Briefly describe why you are reporting this message:');
    if (!reason?.trim()) return;
    try { await request('/api/reports', { method: 'POST', body: JSON.stringify({ messageId: message.id, reason: reason.trim() }) }); notify('Report sent to the server moderators.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Report could not be sent.'); }
  };

  const applyFormatting = (open: string, close = open) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const selection = draft.slice(start, end);
    const next = `${draft.slice(0,start)}${open}${selection || 'text'}${close}${draft.slice(end)}`;
    setDraft(next); requestAnimationFrame(() => { textarea.focus(); const caret = selection ? end + open.length + close.length : start + open.length + 4; textarea.setSelectionRange(caret, caret); });
  };

  const uploadDragDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setDraggingFiles(false);
    if (event.dataTransfer.files.length && (view === 'channel' && activeChannel?.type !== 'voice' || view === 'friends' && activeDmId)) void addFiles(event.dataTransfer.files);
  };

  const selectEmoji = (emoji: string) => {
    const textarea = textareaRef.current;
    if (!textarea) { setDraft((current) => current + emoji); return; }
    const start = textarea.selectionStart, end = textarea.selectionEnd;
    const next = `${draft.slice(0,start)}${emoji}${draft.slice(end)}`;
    setDraft(next); requestAnimationFrame(() => { textarea.focus(); const cursor = start + emoji.length; textarea.setSelectionRange(cursor,cursor); });
    setActivePicker(null);
  };

  const doLogout = () => void signOut();

  const connectToFriend = async (friend: typeof friends[number]) => {
    try { const result = await request<{ conversationId: string }>('/api/dms', { method: 'POST', body: JSON.stringify({ userId: friend.id }) }); stopTyping(); setActiveDmId(result.conversationId); setActiveDmUser(friend.displayName); setActiveDmUserId(friend.id); setView('friends'); setSelectedServerId(null); setSelectedChannelId(null); setMessages([]); setDraft(''); setAttachments([]); setReplyTo(null); setEditing(null); setActivePicker(null); }
    catch (error) { notify(error instanceof Error ? error.message : 'Conversation could not be opened.'); }
  };

  const loadFriends = async () => { try { const result = await request<{ friends: typeof friends }>('/api/friends'); setFriends(result.friends); } catch (error) { notify(error instanceof Error ? error.message : 'Friends could not be loaded.'); } };

  const sendFriendRequest = async (event: FormEvent) => {
    event.preventDefault();
    try { await request('/api/friend-requests', { method: 'POST', body: JSON.stringify({ username: friendQuery.trim() }) }); setFriendQuery(''); await loadFriends(); notify('Friend request sent.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Friend request could not be sent.'); }
  };

  const respondFriend = async (id: string, accept: boolean) => {
    try { await request(`/api/friend-requests/${id}`, { method: 'POST', body: JSON.stringify({ accept }) }); await loadFriends(); notify(accept ? 'Friend request accepted.' : 'Friend request declined.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Friend request could not be updated.'); }
  };

  const sendDm = async () => {
    if (!activeDmId || (!draft.trim() && !attachments.length && !editing) || busy) return;
    stopTyping();
    try {
      if (editing) {
        const result = await request<{ message: Message }>(`/api/messages/${editing.id}`, { method: 'PATCH', body: JSON.stringify({ content: draft.trim() }) });
        setDmMessages((current) => current.map((item) => item.id === result.message.id ? result.message : item));
        setEditing(null); setDraft(''); notify('Message updated.'); return;
      }
      const response = unknownSlashCommandMessage(draft);
      if (response) { setDraft(''); setReplyTo(null); notify(response); return; }
      const id = crypto.randomUUID();
      const content = draft.trim();
      const files = attachments.map((item) => item.file);
      const payload: ChannelMessagePayload = { content, kind: 'text', attachmentIds: [], mentions: [], ...(replyTo ? { replyToId: replyTo.id } : {}) };
      pendingSendsRef.current.set(id, { payload, files, conversationId: activeDmId });
      atBottom.current = true; setIsAtLatest(true);
      setDmMessages((current) => [...current, {
        id, channelId: '', conversationId: activeDmId, authorId: user!.id, authorName: user!.displayName, avatarUrl: user!.avatarUrl,
        content, mentions: [], kind: 'text', stickerEmoji: null, mediaUrl: null, replyToId: replyTo?.id ?? null,
        editedAt: null, deletedAt: null, createdAt: new Date().toISOString(), attachments: [], reactions: [], uploading: files.length > 0,
        deliveryState: 'sending', uploadProgress: files.length ? 0 : undefined, pendingFiles: files.map((file) => ({ name: file.name, size: file.size }))
      }]);
      setDraft(''); setAttachments([]); setReplyTo(null);
      await deliverPendingMessage(id);
    }
    catch (error) { notify(error instanceof Error ? error.message : 'Message was not sent.'); }
  };

  const handleComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatches.length && mentionQuery) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveMentionIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault(); chooseMention(mentionMatches[activeMentionIndex] ?? mentionMatches[0]); return;
      }
    }
    if (event.key === 'Escape' && mentionMatches.length) { setMentionQuery(null); setMentionMatches([]); return; }
    if (event.key === 'Escape') { if (activePicker) setActivePicker(null); else if (editing) { setEditing(null); setDraft(''); } else if (replyTo) setReplyTo(null); }
    if (shouldSendComposerOnEnter(event.key, event.shiftKey, event.nativeEvent.isComposing)) {
      event.preventDefault();
      if (view === 'friends' && activeDmId) void sendDm();
      else void sendMessage();
    }
    if (event.key === 'ArrowUp' && !draft && !editing) { const source = view === 'friends' && activeDmId ? dmMessages : messages; const last = [...source].reverse().find((message) => message.authorId === user?.id && !message.deletedAt); if (last) { event.preventDefault(); setEditing(last); setDraft(last.content); } }
  };

  const currentMessages = view === 'friends' && activeDmId ? dmMessages : messages;
  const currentChannelTitle = view === 'friends' && activeDmId ? activeDmUser ?? 'Direct message' : activeChannel?.name ?? 'Welcome to Orbit Chat';
  const currentTypingRoom = view === 'friends' && activeDmId ? `dm:${activeDmId}` : view === 'channel' && selectedChannelId ? `channel:${selectedChannelId}` : null;
  const currentTypingNames = currentTypingRoom
    ? typingUsers.filter((item) => item.room === currentTypingRoom && item.userId !== user?.id).map((item) => item.displayName)
    : [];
  const sectionedChannels = useMemo(() => {
    if (!activeServer) return [];
    return activeServer.channels.map((channel) => channel);
  }, [activeServer]);
  const orderedCategories = useMemo(() => [...(activeServer?.categories ?? [])].sort((a,b) => a.position-b.position), [activeServer]);
  const knownCategoryIds = useMemo(() => new Set(orderedCategories.map((category) => category.id)), [orderedCategories]);
  const ungroupedTextChannels = sectionedChannels.filter((channel) => channel.type !== 'voice' && (!channel.categoryId || !knownCategoryIds.has(channel.categoryId)));
  const ungroupedVoiceChannels = sectionedChannels.filter((channel) => channel.type === 'voice' && (!channel.categoryId || !knownCategoryIds.has(channel.categoryId)));
  const renderChannelRow = (channel: Channel) => {
    const isVoice = channel.type === 'voice';
    const isMuted = !isVoice && mutedChannelIds.has(channel.id);
    const isUnread = !isVoice && unreadChannelIds.has(channel.id);
    return <div key={channel.id} data-channel-id={channel.id} className={`channel-row ${isVoice ? channel.id === voice.voice?.channelId ? 'voice-active' : '' : channel.id === selectedChannelId ? 'active' : ''} ${isMuted ? 'channel-muted' : ''} ${isUnread ? 'channel-unread' : ''}`}>
      <button className="channel-select" onClick={() => changeChannel(channel)}>{isVoice ? <Volume2 size={16} /> : <Hash size={16} />}<span className={isUnread ? 'channel-name-unread' : ''}>{channel.name}</span>{isUnread && <i className="channel-unread-dot" aria-label="Unread messages" title="Unread messages" />}{isMuted && <BellOff className="muted-channel-icon" size={12} />}</button>
      {isVoice && (voice.voice?.channelId === channel.id ? <button className="voice-join-button connected" title="Leave voice channel" onClick={voice.leave}><Headphones size={15} /></button> : <button className="voice-join-button" title={`Join ${channel.name}`} onClick={() => void voice.join(channel.id)}><Headphones size={15} /></button>)}
      {(!isVoice || canManageServer) && <button className="channel-more" title={`Options for ${channel.name}`} aria-label={`Options for ${channel.name}`} aria-haspopup="menu" aria-expanded={channelMenu?.channel.id === channel.id} onClick={(event) => openChannelMenu(event, channel)}><MoreHorizontal size={15} /></button>}
      {isVoice && voice.voice?.channelId === channel.id && <div className="channel-voice-members"><span className={speakingUserIds.has(user?.id ?? '') ? 'channel-voice-speaking' : ''}><Avatar label={user?.displayName ?? 'You'} url={user?.avatarUrl} size="small" status="online" />{user?.displayName ?? 'You'} <small>You</small></span>{Object.keys(voice.voice.remoteStreams).map((peerId) => { const peer = members.find((member) => member.id === peerId); return <span key={peerId} className={speakingUserIds.has(peerId) ? 'channel-voice-speaking' : ''}><Avatar label={peer?.displayName ?? 'Member'} url={peer?.avatarUrl} size="small" status="online" />{peer?.displayName ?? 'Member'}</span>; })}</div>}
    </div>;
  };

  if (!sessionCheckComplete) return <div className={`boot-screen ${reducedMotion ? 'reduce-motion' : ''}`} role="status" aria-live="polite">
    <div className="boot-starfield" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
    <div className="boot-content">
        <div className="boot-orbit-stage" aria-hidden="true">
        <div className="boot-orbit boot-orbit-outer"><span className="boot-satellite boot-satellite-outer"><i className="boot-planet boot-planet-ice" /></span></div>
        <div className="boot-orbit boot-orbit-middle"><span className="boot-satellite boot-satellite-middle"><i className="boot-planet boot-planet-lilac" /></span></div>
        <div className="boot-orbit boot-orbit-inner"><span className="boot-satellite boot-satellite-inner"><i className="boot-planet boot-planet-pink" /></span></div>
        <div className="boot-center-glow" />
        <Logo />
        <span className="boot-comet"><i /></span>
      </div>
      <div className="boot-brand"><span className="boot-wordmark">ORBIT <span>CHAT</span></span><span className="boot-tagline">YOUR UNIVERSE IS COMING INTO VIEW</span></div>
      <div className="boot-loading"><span className="boot-loading-stars" aria-hidden="true"><i /><i /><i /></span><span>{bootMessage}</span><span className="boot-loading-dots" aria-hidden="true"><i /><i /><i /></span></div>
      <div className="boot-progress" aria-hidden="true"><i /></div>
      <span className="boot-caption">A little patience, then we’re in orbit.</span>
    </div>
  </div>;

  if (!user || !token) return <div className={`auth-shell ${themeClass}`}>
    <header className="titlebar auth-titlebar"><div className="titlebar-brand"><Logo small /><b>Orbit Chat</b></div><div className="titlebar-drag-space" /><WindowButtons /></header>
    <div className="auth-layout">
      <section className="auth-story"><div className="story-orbit story-orbit-one" /><div className="story-orbit story-orbit-two" /><div className="story-content"><Logo /><p className="eyebrow">A place to gather</p><h1>Conversations,<br /><span>in your orbit.</span></h1><p className="story-copy">A quieter home for your communities, close friends, and the conversations that bring them together.</p><div className="story-feature"><span><MessageCircle size={17} /></span><div><b>Built around your communities</b><small>Channels, voice rooms, and private chats.</small></div></div><div className="story-feature"><span><ShieldIcon /></span><div><b>Your server, your rules</b><small>Self-host the backend and keep control of your data.</small></div></div></div><div className="story-foot">A new home for your conversations <span>✦</span></div></section>
      <section className="auth-panel"><div className="auth-card">
        <div className="auth-mobile-brand"><Logo /><b>Orbit Chat</b></div>
        <div className="auth-heading"><h2>{authMode === 'login' ? 'Welcome back' : 'Create your account'}</h2><p>{authMode === 'login' ? 'Sign in to pick up where you left off.' : 'Set up your account and start a community.'}</p></div>
        <form className="auth-form" onSubmit={(event) => void submitAuth(event)}>
          {authMode === 'register' && <label>Display name<input autoComplete="nickname" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={48} placeholder="How people will see you" /></label>}
          <label>Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} maxLength={32} required placeholder="Your username" /></label>
          <label>Password<input autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={authMode === 'register' ? 10 : 1} maxLength={128} placeholder={authMode === 'register' ? 'At least 10 characters' : 'Your password'} /></label>
          {authError && <div className="form-alert" role="alert"><Info size={15} />{authError}</div>}
          {authNotice && <div className="form-notice"><Info size={15} />{authNotice}</div>}
          <button className="button-primary auth-submit" type="submit" disabled={authBusy || !apiUrl}>{authBusy ? <LoaderCircle className="spin" size={17} /> : null}{authMode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <p className="auth-switch">{authMode === 'login' ? 'New to Orbit Chat?' : 'Already have an account?'} <button onClick={() => { setAuthMode((current) => current === 'login' ? 'register' : 'login'); setAuthError(''); }}>{authMode === 'login' ? 'Create an account' : 'Sign in'}</button></p>
        <div className="auth-status" role="status" aria-live="polite"><span className={`connection-led ${connectionDotClass}`} />{availableUpdate && <button className="titlebar-update" title={`Update Orbit Chat to ${availableUpdate.version}`} aria-label={`Update Orbit Chat to ${availableUpdate.version}`} disabled={updaterLaunching} onClick={() => void launchUpdater()}>{updaterLaunching ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}</button>}{connectionStatus === 'online' ? 'Server is online' : connectionStatus === 'offline' ? 'No server response after 30 seconds' : 'Checking server connection…'}<button className="quiet-icon" title="Connection status" onClick={() => notify('Orbit Chat checks the server health endpoint. A yellow dot means it is checking; red means it has not responded for 30 seconds.')}><CircleHelp size={16} /></button></div>
      </div><p className="auth-legal">By continuing, you agree to use Orbit Chat responsibly. Passwords are stored as one-way hashes on the server.</p></section>
    </div>{toast && <Toast text={toast.text} />}</div>;

  const activeVoiceChannel = voice.voice ? activeServer?.channels.find((channel) => channel.id === voice.voice?.channelId) : null;

  return <div className={`app-shell ${themeClass} ${reducedMotion ? 'reduce-motion' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} style={{ fontSize: `calc(14px * var(--font-scale, 1))` }} onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDraggingFiles(true); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingFiles(false); }} onDrop={uploadDragDrop}>
    <header className="titlebar">
      <div className="titlebar-brand"><span className="titlebar-logo"><Logo small /></span><b>Orbit Chat</b><span className="titlebar-separator" /><span className="titlebar-context">{activeServer?.name ?? (view === 'friends' ? 'Friends' : 'Your space')}</span></div>
      <div className="titlebar-drag-space" />
      <div className="titlebar-status" role="status" aria-live="polite"><span className={`connection-led ${connectionDotClass}`} />{connectionLabel}{availableUpdate && <button className="titlebar-update" title={`Update Orbit Chat to ${availableUpdate.version}`} aria-label={`Update Orbit Chat to ${availableUpdate.version}`} disabled={updaterLaunching} onClick={() => void launchUpdater()}>{updaterLaunching ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />}</button>}<span className="version-tag">{runtime?.version}</span></div>
      <WindowButtons />
    </header>

    <div className="workspace">
      <nav className="server-rail" aria-label="Server navigation">
        <button className={`rail-home ${view === 'friends' ? 'selected' : ''}`} title="Friends and messages" onClick={() => { setView('friends'); setSelectedServerId(null); setSelectedChannelId(null); setActiveDmId(null); setMessages([]); setFriendTab('online'); void loadFriends(); }}><Logo small /><span className="rail-tooltip">Friends</span></button>
        <div className="rail-divider" />
        {servers.map((server) => <button key={server.id} className={`server-icon-button ${selectedServerId === server.id && view === 'channel' ? 'selected' : ''}`} title={server.name} onClick={() => changeServer(server)} onContextMenu={(event) => { event.preventDefault(); changeServer(server); notify(`${server.name} · ${server.role}`); }}><span className="server-icon">{server.icon ? <img src={server.icon} alt="" /> : server.name.slice(0,2).toUpperCase()}</span><span className="server-indicator" /><span className="rail-tooltip">{server.name}</span></button>)}
        <button className="rail-add" title="Create a server" onClick={() => { setDialog('server'); setServerName(''); }}><Plus size={20} /><span className="rail-tooltip">Create a server</span></button>
        <button className="rail-add rail-join" title="Join with an invite" onClick={() => { setDialog('join'); setInviteCode(''); }}><Compass size={19} /><span className="rail-tooltip">Join a server</span></button>
        <div className="rail-spacer" />
        <button className="rail-help" title="Help and information" onClick={() => setDialog('settings')}><CircleHelp size={18} /><span className="rail-tooltip">Help & settings</span></button>
      </nav>

      {sidebarCollapsed ? <button className="sidebar-expand" title="Expand sidebar" onClick={() => setSidebarCollapsed(false)}><ChevronRight size={17} /></button> : <aside className="channel-sidebar">
        {view === 'friends' ? <>
          <div className="sidebar-top"><button className="sidebar-menu-button" onClick={() => setDialog('settings')}><span>Direct messages</span><MoreHorizontal size={17} /></button></div>
          <div className="dm-toolbar"><button className="dm-search" onClick={() => setFriendTab('add')}><Search size={15} /><span>Find or start a conversation</span></button></div>
          <div className="dm-friends-heading">DIRECT MESSAGES <button title="New message" onClick={() => setFriendTab('add')}><Plus size={16} /></button></div>
          <div className="dm-list">{friends.filter((item) => item.relation === 'friend').map((friend) => <button key={friend.id} className={`dm-row ${activeDmUserId === friend.id ? 'active' : ''}`} onClick={() => void connectToFriend(friend)}><Avatar label={friend.displayName} size="small" status={onlineUserIds.has(friend.id) ? 'online' : 'offline'} /><span>{friend.displayName}</span></button>)}</div>
          <div className="sidebar-spacer" />
          <UserPanel user={user} voice={voice.voice} onProfile={() => setDialog('profile')} onSettings={() => setDialog('settings')} onLogout={doLogout} onMute={voice.toggleMute} onDeafen={voice.toggleDeafen} onVoiceLeave={voice.leave} notify={notify} />
        </> : <>
          <div className="sidebar-top"><button className="sidebar-menu-button" onClick={() => canManageServer ? setDialog('settings') : notify('Server settings require an administrator role.')}><span>{activeServer?.name ?? 'Your space'}</span><ChevronDown size={16} /></button><button className="server-top-menu" title="Server menu" onClick={() => activeServer ? createInvite() : setDialog('server')}><MoreHorizontal size={17} /></button></div>
          {activeServer ? <>
            <div className="server-actions"><button onClick={() => void createInvite()}><Plus size={14} /> Invite people</button><button onClick={() => openCreateChannel('text')} disabled={!canManageServer}><Plus size={14} /> Create channel</button></div>
            <div className="channel-list" onContextMenu={openChannelAreaMenu}>
              {orderedCategories.map((category) => {
                const categoryChannels = sectionedChannels.filter((channel) => channel.categoryId === category.id);
                const collapsed = collapsedCategoryIds.has(category.id);
                return <section className="channel-category-group" key={category.id} data-category-id={category.id}>
                  <div className="channel-category category-group-heading">
                    <button className="category-toggle" aria-expanded={!collapsed} onClick={() => setCollapsedCategoryIds((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}><ChevronDown size={13} /><span>{category.name}</span></button>
                    <button title={`Create a text channel in ${category.name}`} aria-label={`Create a text channel in ${category.name}`} disabled={!canManageServer} onClick={() => openCreateChannel('text', category.id)}><Plus size={15} /></button>
                  </div>
                  {!collapsed && <div className="category-channel-list">{categoryChannels.map(renderChannelRow)}{!categoryChannels.length && <div className="category-empty">No channels in this category yet.</div>}</div>}
                </section>;
              })}
              <div className="channel-category"><span>TEXT CHANNELS</span><button title="Create text channel" disabled={!canManageServer} onClick={() => openCreateChannel('text')}><Plus size={15} /></button></div>
              {ungroupedTextChannels.map(renderChannelRow)}
              <div className="channel-category voice-category"><span>VOICE CHANNELS</span><button title="Create voice channel" disabled={!canManageServer} onClick={() => openCreateChannel('voice')}><Plus size={15} /></button></div>
              {ungroupedVoiceChannels.map(renderChannelRow)}
              {!activeServer.channels.length && <div className="sidebar-empty"><span>No channels yet.</span>{canManageServer && <button onClick={() => openCreateChannel('text')}>Create one</button>}</div>}
            </div>
          </> : <div className="no-server-sidebar"><div className="no-server-orbit"><Logo /></div><b>Your space is waiting</b><p>Create a server or join a community with an invite code.</p><button className="button-primary" onClick={() => setDialog('server')}><Plus size={16} /> Create server</button><button className="button-subtle" onClick={() => setDialog('join')}><Compass size={16} /> Join a server</button></div>}
          {!activeServer && <div className="sidebar-spacer" />}
          <UserPanel user={user} voice={voice.voice} onProfile={() => setDialog('profile')} onSettings={() => setDialog('settings')} onLogout={doLogout} onMute={voice.toggleMute} onDeafen={voice.toggleDeafen} onVoiceLeave={voice.leave} notify={notify} />
        </>}
      </aside>}

      <main className="main-pane">
        <div className="channel-header">
          <div className="channel-header-title"><span className="channel-header-icon">{view === 'friends' ? <Users size={19} /> : activeChannel?.type === 'voice' ? <Volume2 size={19} /> : <Hash size={19} />}</span><b>{currentChannelTitle}</b>{activeChannel?.topic && <span className="channel-topic">{activeChannel.topic}</span>}</div>
          <div className="channel-header-actions">
            <button title="Friends" className={`header-tool ${view === 'friends' ? 'tool-active' : ''}`} onClick={() => { setView('friends'); setSelectedServerId(null); setSelectedChannelId(null); setActiveDmId(null); setMessages([]); void loadFriends(); }}><Users size={18} /></button>
            <button title="Search messages" className="header-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages" /></button>
            {view === 'channel' && activeServer && <button title={showMembers ? 'Hide member list' : 'Show member list'} className={`header-tool ${showMembers ? 'tool-active' : ''}`} onClick={() => { setShowMembers((value) => !value); if (!showMembers) void loadMembers(); }}><Users size={18} /></button>}
            <button title="Settings" className="header-tool" onClick={() => setDialog('settings')}><Settings size={18} /></button>
          </div>
        </div>

        {view === 'channel' && activeChannel?.type === 'voice' ? <section className="voice-room-view">
          <div className="voice-room-heading"><span className="voice-room-status-dot" /><div><small>VOICE CHANNEL</small><h1>{activeChannel.name}</h1></div><span className="voice-room-count"><Users size={13} /> {voice.voice?.channelId === activeChannel.id ? 1 + Object.keys(voice.voice.remoteStreams).length : 0}</span></div>
          {voice.voice?.channelId === activeChannel.id ? <div className={`voice-participant-grid ${Object.keys(voice.voice.remoteStreams).length >= 2 ? 'voice-participant-grid-many' : 'voice-participant-grid-few'}`}>
            <VoiceParticipant user={user} muted={voice.voice.muted} speaking={speakingUserIds.has(user.id)} stream={voice.voice.stream} />
            {Object.entries(voice.voice.remoteStreams).map(([peerId, stream]) => {
              const peer = members.find((member) => member.id === peerId);
              return <VoiceParticipant key={peerId} user={peer ?? { id: peerId, username: peerId, displayName: 'Member', avatarUrl: null, about: '', status: 'online', createdAt: '' }} stream={stream} speaking={speakingUserIds.has(peerId)} />;
            })}
          </div> : <div className="voice-room-empty"><div className="voice-room-orbit"><Headphones size={32} /></div><h2>Ready to join?</h2><p>Join the room to talk with everyone here.</p><button className="button-primary" onClick={() => void voice.join(activeChannel.id)}><Headphones size={16} /> Join voice</button></div>}
          {voice.voice?.channelId === activeChannel.id && <div className="voice-room-toolbar"><span className="voice-room-connected"><span className="connection-led connected" />Connected to {activeChannel.name} · {Math.floor(voiceDuration / 60).toString().padStart(2, '0')}:{(voiceDuration % 60).toString().padStart(2, '0')}</span><div><button className={voice.voice.muted ? 'voice-room-control active' : 'voice-room-control'} title={voice.voice.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={voice.toggleMute}>{voice.voice.muted ? <MicOff size={17} /> : <Mic size={17} />}</button><button className={voice.voice.deafened ? 'voice-room-control active' : 'voice-room-control'} title={voice.voice.deafened ? 'Enable audio' : 'Deafen'} onClick={voice.toggleDeafen}>{voice.voice.deafened ? <VolumeX size={17} /> : <Headphones size={17} />}</button><button className="voice-room-control voice-room-leave" title="Leave voice" onClick={voice.leave}><PhoneHangupIcon /></button></div></div>}
        </section> : view === 'friends' && !activeDmId ? <section className="friends-view">
          <div className="friends-tabs"><div><b>Friends</b><span className="friends-divider" />{(['online','all','pending','add'] as const).map((tab) => <button key={tab} className={`${friendTab === tab ? 'active' : ''} ${tab === 'add' ? 'friend-add-tab' : ''}`} onClick={() => setFriendTab(tab)}>{tab === 'online' ? 'Online' : tab === 'all' ? 'All' : tab === 'pending' ? `Pending${friends.some((f) => f.relation === 'incoming') ? ` · ${friends.filter((f) => f.relation === 'incoming').length}` : ''}` : 'Add friend'}</button>)}</div><button className="friends-invite" onClick={() => setDialog('join')}><Plus size={15} /> Join a community</button></div>
          {friendTab === 'add' ? <div className="friend-add-panel"><h2>Add a friend</h2><p>You can add someone using their Orbit Chat username.</p><form onSubmit={(event) => void sendFriendRequest(event)}><input value={friendQuery} onChange={(event) => setFriendQuery(event.target.value)} placeholder="Enter a username" minLength={3} maxLength={32} required /><button className="button-primary" type="submit">Send request</button></form></div> : <div className="friends-content"><div className="friends-list-heading">{friendTab === 'online' ? 'ONLINE' : friendTab === 'pending' ? 'PENDING' : 'ALL FRIENDS'} <span>{friends.filter((friend) => friendTab === 'online' ? friend.relation === 'friend' && onlineUserIds.has(friend.id) : friendTab === 'pending' ? friend.relation !== 'friend' : friend.relation === 'friend').length}</span></div>
            {friends.filter((friend) => friendTab === 'online' ? friend.relation === 'friend' && onlineUserIds.has(friend.id) : friendTab === 'pending' ? friend.relation !== 'friend' : friend.relation === 'friend').map((friend) => <div key={friend.requestId ?? friend.id} className="friend-row"><Avatar label={friend.displayName} size="normal" status={onlineUserIds.has(friend.id) ? 'online' : 'offline'} /><div className="friend-details"><b>{friend.displayName}</b><small>{friend.relation === 'incoming' ? 'Incoming friend request' : friend.relation === 'outgoing' ? 'Request sent' : onlineUserIds.has(friend.id) ? 'Online' : 'Offline'} · @{friend.username}</small></div>{friend.relation === 'incoming' ? <div className="friend-actions"><button className="friend-accept" title="Accept request" onClick={() => void respondFriend(friend.requestId ?? friend.id, true)}><Check size={16} /></button><button className="friend-decline" title="Decline request" onClick={() => void respondFriend(friend.requestId ?? friend.id, false)}><X size={16} /></button></div> : friend.relation === 'outgoing' ? <span className="request-sent">Request sent</span> : <button className="friend-message" title="Message" onClick={() => void connectToFriend(friend)}><MessageCircle size={17} /></button>}</div>)}
            {friends.filter((friend) => friendTab === 'online' ? friend.relation === 'friend' && onlineUserIds.has(friend.id) : friendTab === 'pending' ? friend.relation !== 'friend' : friend.relation === 'friend').length === 0 && <div className="friends-empty"><Users size={28} /><b>{friendTab === 'online' ? 'It’s quiet out there' : friendTab === 'pending' ? 'No pending requests' : 'Your list is just getting started'}</b><p>{friendTab === 'online' ? 'Friends will appear here when they come online.' : 'Find people by their Orbit Chat username.'}</p>{friendTab !== 'online' && <button className="button-primary" onClick={() => setFriendTab('add')}>Add a friend</button>}</div>}
          </div>}
        </section> : view === 'friends' && activeDmId ? <>
          <div className="message-list dm-message-list" ref={scrollRef} onLoadCapture={() => { if (atBottom.current) scrollToLatest(); }}>{dmMessages.map((message, index) => <MessageRow key={message.id} message={message} previous={dmMessages[index - 1]} replyTarget={dmMessages.find((item) => item.id === message.replyToId)} user={user} baseUrl={apiUrl} token={token} canModerate={false} onReply={(item) => { setReplyTo(item); setEditing(null); textareaRef.current?.focus(); }} onEdit={(item) => { setEditing(item); setReplyTo(null); setDraft(item.content); textareaRef.current?.focus(); }} onDelete={(item) => void removeMessage(item)} onReport={(item) => void reportMessage(item)} onReact={(item, emoji) => void toggleReaction(item, emoji)} onOpenImage={(url,name) => setMediaViewer({url,name,zoom:1})} onJumpToMessage={(id) => document.getElementById(`message-${id}`)?.scrollIntoView({behavior:'smooth',block:'center'})} onToast={notify} onRetry={retryPendingMessage} onCancel={cancelPendingMessage} themeLight={themeClass === 'theme-light'} contextMenuOpen={activeMessageMenuId === message.id} onOpenContextMenu={() => setActiveMessageMenuId(message.id)} onCloseContextMenu={() => setActiveMessageMenuId(null)} />)}</div>
          {currentTypingNames.length > 0 && <TypingIndicator names={currentTypingNames} />}<Composer value={draft} setValue={setDraft} onTypingChange={reportTyping} onMentionInput={() => undefined} mentionMatches={[]} activeMentionIndex={0} onMentionSelect={() => undefined} onSend={() => void sendDm()} onKeyDown={handleComposerKey} inputRef={textareaRef} placeholder={editing ? 'Edit your message' : `Message ${currentChannelTitle}`} attachments={attachments} uploadProgress={uploadProgress} uploadSpeed={uploadSpeed} selectedGif={null} replyTo={replyTo} editing={editing} activePicker={activePicker} setActivePicker={setActivePicker} pickerRef={pickerRef} onFiles={addFiles} onEmoji={selectEmoji} gifs={gifs} gifNext={gifNext} onLoadMoreGifs={() => void loadMoreGifs()} gifLoading={gifLoading} gifError={gifError} gifSearch={gifSearch} setGifSearch={setGifSearch} onSelectGif={() => undefined} stickers={stickers} onSticker={() => undefined} fileInputRef={fileInputRef} onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} onRemoveGif={() => setSelectedGif(null)} onCancelReply={() => setReplyTo(null)} onCancelEdit={() => { setEditing(null); setDraft(''); }} busy={busy} onFormat={applyFormatting} disabled={!activeDmId} mediaEnabled={false} emojiEnabled filesEnabled={false} gifEnabled={false} stickersEnabled={false} />
        </> : <>
          {!activeChannel ? <div className="welcome-empty"><div className="welcome-art"><Logo /></div><p className="eyebrow">A good place to start</p><h1>Welcome to Orbit Chat</h1><p>Create a server for your community, or join one with an invite from a friend. Your conversations will appear here.</p><div className="welcome-actions"><button className="button-primary" onClick={() => { setDialog('server'); setServerName(''); }}><Plus size={17} /> Create a server</button><button className="button-subtle" onClick={() => { setDialog('join'); setInviteCode(''); }}><Compass size={17} /> Join with an invite</button></div></div> : activeChannel.type === 'voice' ? null : <>
            <div className="chat-scroll-area" onDragOver={(event) => event.preventDefault()}>
              <div className="message-list" ref={scrollRef} onLoadCapture={() => { if (atBottom.current) scrollToLatest(); }} onScroll={(event) => {
                const element = event.currentTarget;
                updateLatestState(element);
                if (element.scrollTop < 80 && hasMore && !loadingMessages && !loadingOlderMessagesRef.current && displayedMessages.length && selectedChannelId) {
                  loadingOlderMessagesRef.current = true;
                  const requestGeneration = ++olderMessagesGenerationRef.current;
                  const channelId = selectedChannelId;
                  const firstMessage = displayedMessages[0];
                  prependScrollPosition.current = { channelId, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop };
                  setLoadingMessages(true);
                  void apiRequest<{ messages: Message[]; hasMore: boolean }>(apiUrl, token, `/api/channels/${channelId}/messages?before=${encodeURIComponent(firstMessage.createdAt)}`)
                    .then((result) => {
                      if (olderMessagesGenerationRef.current !== requestGeneration || selectedChannelRef.current !== channelId) return;
                      setMessages((current) => [...result.messages.filter((item) => !current.some((existing) => existing.id === item.id)), ...current]);
                      setHasMore(result.hasMore);
                      requestAnimationFrame(() => requestAnimationFrame(() => {
                        const position = prependScrollPosition.current;
                        const list = scrollRef.current;
                        if (list && position?.channelId === channelId && selectedChannelRef.current === channelId) {
                          list.scrollTop = position.scrollTop + list.scrollHeight - position.scrollHeight;
                          updateLatestState(list);
                        }
                        if (position?.channelId === channelId) prependScrollPosition.current = null;
                      }));
                    })
                    .catch((error) => notify(error instanceof Error ? error.message : 'Older messages could not be loaded.'))
                    .finally(() => {
                      if (olderMessagesGenerationRef.current === requestGeneration) {
                        loadingOlderMessagesRef.current = false;
                        setLoadingMessages(false);
                      }
                    });
                }
              }}>
                {loadingMessages && <div className="timeline-loading"><LoaderCircle className="spin" size={17} /> Loading messages…</div>}
                {displayedMessages.length === 0 && !loadingMessages && <div className="channel-welcome"><span className="channel-welcome-icon"><Hash size={26} /></span><h2>Welcome to #{activeChannel.name}</h2><p>{activeChannel.topic || 'This is the beginning of this channel.'}{activeServer?.ownerId === user.id ? ' Start the conversation when you’re ready.' : ''}</p></div>}
                {displayedMessages.map((message, index) => <MessageRow key={message.id} message={message} previous={displayedMessages[index - 1]} user={user} baseUrl={apiUrl} token={token} canModerate={canManageServer ?? false} replyTarget={messages.find((item) => item.id === message.replyToId)} onReply={(item) => { setReplyTo(item); setEditing(null); textareaRef.current?.focus(); }} onEdit={(item) => { setEditing(item); setReplyTo(null); setDraft(item.content); textareaRef.current?.focus(); }} onDelete={(item) => void removeMessage(item)} onReport={(item) => void reportMessage(item)} onReact={(item, emoji) => void toggleReaction(item, emoji)} onOpenImage={(url,name) => setMediaViewer({url,name,zoom:1})} onJumpToMessage={(id) => { const element = document.getElementById(`message-${id}`); element?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }} onToast={notify} onRetry={retryPendingMessage} onCancel={cancelPendingMessage} themeLight={themeClass === 'theme-light'} contextMenuOpen={activeMessageMenuId === message.id} onOpenContextMenu={() => setActiveMessageMenuId(message.id)} onCloseContextMenu={() => setActiveMessageMenuId(null)} />)}

              </div>
              {!isAtLatest && messages.length > 12 && <button className="jump-latest" onClick={() => scrollToLatest()}><ArrowDown size={15} /> Jump to latest</button>}
            </div>
            {voice.voice && <div className="voice-status-strip" role="status" aria-label="Voice connection controls">
              <span className="voice-strip-mark"><Headphones size={16} /><span className="connection-led connected" /></span>
              <span className="voice-strip-copy"><b>Voice connected</b><small>in {activeVoiceChannel?.name ?? 'channel'}</small></span>
              <span className="voice-strip-live"><span className="connection-led connected" />LIVE</span>
              <span className="voice-status-spacer" />
              <div className="voice-strip-actions">
                <button className={voice.voice.muted ? 'voice-control-muted' : ''} onClick={voice.toggleMute} title={voice.voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-label={voice.voice.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={voice.voice.muted}>{voice.voice.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
                <button className={voice.voice.deafened ? 'voice-control-deafened' : ''} onClick={voice.toggleDeafen} title={voice.voice.deafened ? 'Enable audio' : 'Deafen'} aria-label={voice.voice.deafened ? 'Enable audio' : 'Deafen'} aria-pressed={voice.voice.deafened}>{voice.voice.deafened ? <VolumeX size={16} /> : <Headphones size={16} />}</button>
                <button className="voice-leave" onClick={voice.leave} title="Disconnect voice" aria-label="Disconnect voice"><X size={16} /></button>
              </div>
            </div>}
            {currentTypingNames.length > 0 && <TypingIndicator names={currentTypingNames} />}<Composer value={draft} setValue={setDraft} onTypingChange={reportTyping} onMentionInput={updateMentionSuggestions} mentionMatches={mentionMatches} activeMentionIndex={activeMentionIndex} onMentionSelect={chooseMention} onSend={() => void sendMessage()} onKeyDown={handleComposerKey} inputRef={textareaRef} placeholder={editing ? 'Edit your message' : `Message #${activeChannel.name}`} attachments={attachments} uploadProgress={uploadProgress} uploadSpeed={uploadSpeed} selectedGif={selectedGif} replyTo={replyTo} editing={editing} activePicker={activePicker} setActivePicker={setActivePicker} pickerRef={pickerRef} onFiles={addFiles} onEmoji={selectEmoji} gifs={gifs} gifNext={gifNext} onLoadMoreGifs={() => void loadMoreGifs()} gifLoading={gifLoading} gifError={gifError} gifSearch={gifSearch} setGifSearch={setGifSearch} onSelectGif={(gif) => { setSelectedGif(gif); setActivePicker(null); textareaRef.current?.focus(); }} stickers={stickers} onSticker={(sticker) => void sendSticker(sticker)} fileInputRef={fileInputRef} onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))} onRemoveGif={() => setSelectedGif(null)} onCancelReply={() => setReplyTo(null)} onCancelEdit={() => { setEditing(null); setDraft(''); }} busy={busy} onFormat={applyFormatting} disabled={activeChannel.type !== 'text' && activeChannel.type !== 'announcement'} mediaEnabled={!editing} />
          </>}
        </>}
      </main>

      {showMembers && activeServer && view === 'channel' && <aside className="member-sidebar"><div className="member-heading">MEMBERS <span>{members.length}</span><button title="Refresh members" onClick={() => void loadMembers()}><Activity size={15} /></button></div><div className="member-list">{members.map((member) => <div key={member.id} className="member-row"><Avatar label={member.displayName} url={member.avatarUrl} size="small" status={onlineUserIds.has(member.id) ? member.status : 'offline'} /><span>{member.displayName}{member.id === activeServer.ownerId && <small>OWNER</small>}</span></div>)}</div></aside>}
    </div>

    {draggingFiles && <div className="drop-overlay"><div><FileImage size={34} /><b>{view === 'channel' && activeChannel?.type === 'voice' || view === 'friends' && !activeDmId ? 'Choose a text channel or conversation first' : 'Drop to add files to your message'}</b><span>Archives, documents, media and more · up to 20 GB per upload</span></div></div>}
    {dialog && <Dialog mode={dialog} setMode={setDialog} serverName={serverName} setServerName={setServerName} onCreateServer={createServer} inviteCode={inviteCode} setInviteCode={setInviteCode} onJoinServer={joinServer} channelName={channelName} setChannelName={setChannelName} channelType={channelType} setChannelType={setChannelType} topic={topic} setTopic={setTopic} channelCategoryId={channelCategoryId} setChannelCategoryId={setChannelCategoryId} categories={activeServer?.categories ?? []} onCreateChannel={createChannel} categoryName={categoryName} setCategoryName={setCategoryName} onCreateCategory={createCategory} inviteLink={inviteLink} activeServer={activeServer} user={user} token={token} notify={notify} theme={theme} setTheme={setTheme} fontScale={fontScale} setFontScale={setFontScale} desktopNotifications={desktopNotifications} setDesktopNotifications={setDesktopNotifications} reducedMotion={reducedMotion} setReducedMotion={setReducedMotion} voiceSounds={voiceSounds} setVoiceSounds={setVoiceSounds} sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed} onLogout={doLogout} runtime={runtime} apiUrl={apiUrl} audioDevices={audioDevices} voiceInputDeviceId={voiceInputDeviceId} setVoiceInputDeviceId={setVoiceInputDeviceId} voiceOutputDeviceId={voiceOutputDeviceId} setVoiceOutputDeviceId={setVoiceOutputDeviceId} onSelectInputDevice={voice.selectInputDevice} onSelectOutputDevice={voice.selectOutputDevice} busy={busy} onProfileChange={(updated) => window.dispatchEvent(new CustomEvent('orbit:profile', { detail: updated }))} />}
    {channelAreaMenu && <div className="channel-area-menu" role="menu" aria-label="Create in this server" style={{ left: channelAreaMenu.left, top: channelAreaMenu.top }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="channel-area-menu-title"><span>QUICK CREATE</span><small>{channelAreaMenu.categoryId ? orderedCategories.find((category) => category.id === channelAreaMenu.categoryId)?.name : activeServer?.name}</small></div>
      <button role="menuitem" onClick={() => openCreateChannel('text', channelAreaMenu.categoryId ?? '')}><Hash size={16} /><span>Text channel</span></button>
      <button role="menuitem" onClick={() => openCreateChannel('voice', channelAreaMenu.categoryId ?? '')}><Volume2 size={16} /><span>Voice channel</span></button>
      <div className="channel-menu-divider" />
      <button role="menuitem" onClick={() => { setCategoryName(''); setChannelAreaMenu(null); setDialog('category'); }}><FolderPlus size={16} /><span>Create category</span></button>
    </div>}
    {channelMenu && <div className="channel-action-menu" role="menu" aria-label={`${channelMenu.channel.name} channel options`} style={{ left: channelMenu.left, top: channelMenu.top }} onPointerDown={(event) => event.stopPropagation()}>
      <div className="channel-menu-heading"><span>{channelMenu.channel.type === 'voice' ? <Volume2 size={17} /> : <Hash size={17} />}</span><div><b>{channelMenu.channel.name}</b><small>{channelMenu.channel.type === 'voice' ? 'VOICE CHANNEL' : 'TEXT CHANNEL'}</small></div></div>
      {channelMenu.canManage && <button className="channel-menu-item" role="menuitem" onClick={() => { setChannelSettings(channelMenu.channel); setChannelMenu(null); }}><Settings size={16} /><span>Channel settings</span></button>}
      {channelMenu.channel.type !== 'voice' && <button className="channel-menu-item" role="menuitem" onClick={() => { toggleChannelMute(channelMenu.channel); setChannelMenu(null); }}>{mutedChannelIds.has(channelMenu.channel.id) ? <Bell size={16} /> : <BellOff size={16} />}<span>{mutedChannelIds.has(channelMenu.channel.id) ? 'Unmute channel' : 'Mute channel'}</span>{mutedChannelIds.has(channelMenu.channel.id) && <small>ON</small>}</button>}
      {channelMenu.canManage && <button className="channel-menu-item" role="menuitem" onClick={() => void duplicateChannel(channelMenu.channel)}><Copy size={16} /><span>Duplicate channel</span></button>}
      {channelMenu.channel.type !== 'voice' && <button className="channel-menu-item" role="menuitem" disabled={!unreadChannelIds.has(channelMenu.channel.id)} onClick={() => markChannelRead(channelMenu.channel)}><Check size={16} /><span>Mark as read</span></button>}
      {channelMenu.canManage && <>
        <div className="channel-menu-divider" />
        <button className="channel-menu-item channel-menu-danger" role="menuitem" disabled={!channelMenu.canDelete} title={!channelMenu.canDelete ? 'A server must keep at least one channel.' : `Delete #${channelMenu.channel.name}`} onClick={() => deleteChannel(channelMenu.channel)}><Trash2 size={16} /><span>Delete channel</span></button>
      </>}
    </div>}
    {channelSettings && <ChannelSettingsDialog key={channelSettings.id} channel={channelSettings} busy={channelSettingsBusy} onClose={() => { if (!channelSettingsBusy) setChannelSettings(null); }} onSave={(event, name, channelTopic) => void saveChannelSettings(event, channelSettings, name, channelTopic)} />}
    {confirmAction && <ConfirmDialog action={confirmAction} busy={confirmBusy} onClose={() => setConfirmAction(null)} onConfirm={() => void confirmDelete()} />}
    {mediaViewer && <div className="media-viewer" role="dialog" aria-modal="true" onClick={() => setMediaViewer(null)} onKeyDown={(event) => { if (event.key === 'Escape') setMediaViewer(null); }}><div className="media-viewer-bar" onClick={(event) => event.stopPropagation()}><b>{mediaViewer.name}</b><div><button title="Zoom out" onClick={() => setMediaViewer((current) => current && ({ ...current, zoom: Math.max(.5, current.zoom - .25) }))}>−</button><button title="Reset zoom" onClick={() => setMediaViewer((current) => current && ({ ...current, zoom: 1 }))}>Fit</button><button title="Zoom in" onClick={() => setMediaViewer((current) => current && ({ ...current, zoom: Math.min(3, current.zoom + .25) }))}>+</button><button title="Download" onClick={() => { const link = document.createElement('a'); link.href = mediaViewer.url; link.download = mediaViewer.name; link.click(); }}><Download size={18} /></button><button title="Close" onClick={() => setMediaViewer(null)}><X size={20} /></button></div></div><img src={mediaViewer.url} alt={mediaViewer.name} style={{ transform: `scale(${mediaViewer.zoom})` }} onClick={(event) => event.stopPropagation()} /></div>}
    {toast && <Toast text={toast.text} />}
    <div className="remote-audio-bin" aria-hidden="true">{voice.voice && Object.entries(voice.voice.remoteStreams).map(([peerId, stream]) => <RemoteAudio key={peerId} stream={stream} muted={voice.voice?.deafened ?? false} label={`Audio from ${peerId}`} outputDeviceId={voiceOutputDeviceId} />)}</div>
  </div>;
}

function WindowButtons() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    void window.orbit.window.isMaximized().then(setMaximized);
    return window.orbit.window.onMaximized(setMaximized);
  }, []);
  return <div className="window-controls"><button title="Minimize" onClick={() => window.orbit.window.minimize()}><span>−</span></button><button title={maximized ? 'Restore' : 'Maximize'} onClick={() => window.orbit.window.toggleMaximize()}><span>{maximized ? '▣' : '□'}</span></button><button className="window-close" title="Close" onClick={() => window.orbit.window.close()}><X size={14} /></button></div>;
}

function ShieldIcon() { return <span className="shield-glyph">✦</span>; }

function UserPanel({ user, voice, onProfile, onSettings, onLogout, onMute, onDeafen, onVoiceLeave, notify }: { user: User; voice: ReturnType<typeof useVoice>['voice']; onProfile(): void; onSettings(): void; onLogout(): void; onMute(): void; onDeafen(): void; onVoiceLeave(): void; notify(text: string): void }) {
  return <div className="user-panel">
    {voice && <div className="user-voice-status"><span className="connection-led connected" /><div><b>Voice connected</b><small>Click headphones to disconnect</small></div><button title="Disconnect voice" onClick={onVoiceLeave}><X size={15} /></button></div>}
    <button className="user-identity" onClick={onProfile}><span className="user-avatar-ring"><Avatar label={user.displayName} url={user.avatarUrl} status={user.status} /><i><Image size={9} /></i></span><span><b>{user.displayName}</b><small>@{user.username}</small></span></button>
    <div className="user-actions">
      <button title={voice ? voice.muted ? 'Unmute microphone' : 'Mute microphone' : 'Join a voice channel to use your microphone'} className={voice?.muted ? 'action-on' : ''} onClick={() => voice ? onMute() : notify('Join a voice channel first to use your microphone.')} aria-pressed={voice?.muted ?? false}>{voice?.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
      <button title={voice ? voice.deafened ? 'Enable audio' : 'Deafen' : 'Join a voice channel to manage audio'} className={voice?.deafened ? 'action-on' : ''} onClick={() => voice ? onDeafen() : notify('Join a voice channel first to manage voice audio.')} aria-pressed={voice?.deafened ?? false}>{voice?.deafened ? <VolumeX size={16} /> : <Headphones size={16} />}</button>
      <button title="User settings" onClick={onSettings}><Settings size={16} /></button>
      <button title="Log out" onClick={onLogout}><LogOut size={15} /></button>
    </div>
  </div>;
}

function VoiceParticipant({ user, stream, speaking, muted = false }: { user: User; stream: MediaStream; speaking: boolean; muted?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    void videoRef.current.play().catch(() => undefined);
  }, [stream]);
  return <article className={`voice-participant ${speaking ? 'voice-participant-speaking' : ''}`}>
    {stream.getVideoTracks().length > 0 && <video ref={videoRef} autoPlay playsInline muted={muted} aria-label={`${user.displayName} video`} />}
    <div className="voice-participant-placeholder"><Avatar label={user.displayName} url={user.avatarUrl} size="large" /></div>
    <div className="voice-participant-label">{muted && <MicOff size={13} />}<b>{user.displayName}</b>{user.status !== 'online' && <small>{user.status}</small>}</div>
  </article>;
}

function PhoneHangupIcon() { return <span className="phone-hangup-icon" aria-hidden="true">☎</span>; }

function RemoteAudio({ stream, muted, label, outputDeviceId }: { stream: MediaStream; muted: boolean; label: string; outputDeviceId: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = stream;
    const output = audio as HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
    if (output.setSinkId) void output.setSinkId(outputDeviceId).catch(() => undefined);
    void audio.play().catch(() => undefined);
  }, [stream, outputDeviceId]);
  return <audio ref={audioRef} autoPlay playsInline muted={muted} aria-label={label} />;
}

function Toast({ text }: { text: string }) { return <div className="toast-message" role="status"><Info size={16} />{text}</div>; }

function TypingIndicator({ names }: { names: string[] }) {
  if (!names.length) return null;
  const text = names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
    : `${names[0]}, ${names[1]}, and others are typing…`;
  return <div className="typing-indicator" role="status" aria-live="polite"><span className="typing-indicator-dots" aria-hidden="true"><i /><i /><i /></span>{text}</div>;
}

function Composer(props: {
  value: string; setValue(value: string): void; onMentionInput(value: string, caret: number): void; mentionMatches: Member[]; activeMentionIndex: number; onMentionSelect(member: Member): void;
  onSend(): void; onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void;
  onTypingChange(active: boolean): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>; placeholder: string; attachments: QueuedFile[]; selectedGif: GifItem | null;
  replyTo: Message | null; editing: Message | null; activePicker: PickerMode; setActivePicker(value: PickerMode): void;
  pickerRef: React.RefObject<HTMLDivElement | null>; onFiles(files: FileList | File[]): Promise<void>; onEmoji(emoji: string): void;
  gifs: GifItem[]; gifNext: string; onLoadMoreGifs(): void; gifLoading: boolean; gifError: string; gifSearch: string; setGifSearch(value: string): void; onSelectGif(gif: GifItem): void;
  stickers: typeof stickers; onSticker(sticker: typeof stickers[number]): void; fileInputRef: React.RefObject<HTMLInputElement | null>;
  onRemoveAttachment(id: string): void; onRemoveGif(): void; onCancelReply(): void; onCancelEdit(): void;
  busy: boolean; uploadProgress?: number | null; uploadSpeed?: string; onFormat(open: string, close?: string): void; disabled: boolean; mediaEnabled?: boolean;
  filesEnabled?: boolean; emojiEnabled?: boolean; gifEnabled?: boolean; stickersEnabled?: boolean;
}) {
  const { value, setValue, onMentionInput, mentionMatches, activeMentionIndex, onMentionSelect, onSend, onKeyDown, onTypingChange, inputRef, placeholder, attachments, uploadProgress, uploadSpeed, selectedGif, replyTo, editing, activePicker, setActivePicker, pickerRef, onFiles, onEmoji, gifs, gifNext, onLoadMoreGifs, gifLoading, gifError, gifSearch, setGifSearch, onSelectGif, stickers, onSticker, fileInputRef, onRemoveAttachment, onRemoveGif, onCancelReply, onCancelEdit, busy, onFormat, disabled, mediaEnabled = true } = props;
  const filesEnabled = props.filesEnabled ?? mediaEnabled;
  const emojiEnabled = props.emojiEnabled ?? mediaEnabled;
  const gifEnabled = props.gifEnabled ?? mediaEnabled;
  const stickersEnabled = props.stickersEnabled ?? mediaEnabled;
  const autoResize = (event: React.ChangeEvent<HTMLTextAreaElement>) => { setValue(event.target.value); onTypingChange(Boolean(event.target.value.trim())); onMentionInput(event.target.value, event.currentTarget.selectionStart); event.currentTarget.style.height = 'auto'; event.currentTarget.style.height = `${Math.min(168, event.currentTarget.scrollHeight)}px`; };
  return <div className="composer-area" ref={pickerRef}>
    {replyTo && <div className="reply-composer-banner"><Reply size={14} /><span>Replying to <b>{replyTo.authorName}</b></span><button title="Cancel reply" onClick={() => { onCancelReply(); inputRef.current?.focus(); }}><X size={15} /></button></div>}
    {editing && <div className="reply-composer-banner editing-banner"><PencilIcon /><span>Editing message</span><button title="Cancel edit" onClick={onCancelEdit}><X size={15} /></button></div>}
    {(attachments.length > 0 || selectedGif) && <div className="composer-attachments">{attachments.map(({ id, file }) => <div key={id} className="composer-file-preview"><File size={17} /><span title={file.name}>{file.name}</span><small>{formatBytes(file.size)}</small><button title={`Remove ${file.name}`} onClick={() => onRemoveAttachment(id)}><X size={14} /></button></div>)}{selectedGif && <div className="composer-gif-preview"><img src={selectedGif.previewUrl} alt="Selected GIF" /><span>GIF selected</span><button title="Remove GIF" onClick={onRemoveGif}><X size={14} /></button></div>}</div>}
    <div className="composer-shell">
      {uploadProgress !== null && uploadProgress !== undefined && <div className="composer-upload-status" role="status"><span className="composer-upload-track"><i style={{ width: `${uploadProgress}%` }} /></span><b>Uploading files · {uploadProgress}% · {uploadSpeed || '0 KB/s'}</b></div>}
      {filesEnabled && <button className="composer-plus" title="Attach a file" onClick={() => { setActivePicker(activePicker === 'attach' ? null : 'attach'); }} disabled={disabled || busy}><Plus size={20} /></button>}
      <div className="composer-input-wrap"><textarea ref={inputRef} value={value} onChange={autoResize} onBlur={() => onTypingChange(false)} onClick={(event) => onMentionInput(value, event.currentTarget.selectionStart)} onKeyUp={(event) => onMentionInput(value, event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder={disabled ? 'Messages are unavailable in this channel.' : placeholder} rows={1} maxLength={4000} disabled={disabled} aria-label="Message" aria-autocomplete={mentionMatches.length ? 'list' : undefined} aria-controls={mentionMatches.length ? 'mention-suggestions' : undefined} />
        <div className="composer-buttons">
          {emojiEnabled && <button title="Emoji" onClick={() => setActivePicker(activePicker === 'emoji' ? null : 'emoji')} disabled={disabled}><Smile size={19} /></button>}
          {gifEnabled && <button title="GIF" onClick={() => setActivePicker(activePicker === 'gif' ? null : 'gif')} disabled={disabled}><span className="gif-button-label">GIF</span></button>}
          {stickersEnabled && <button title="Stickers" onClick={() => setActivePicker(activePicker === 'sticker' ? null : 'sticker')} disabled={disabled}><Sticker size={18} /></button>}
        </div>
        {mentionMatches.length > 0 && <div id="mention-suggestions" className="mention-suggestions" role="listbox" aria-label="Mention a server member">{mentionMatches.map((member, index) => <button key={member.id} type="button" role="option" aria-selected={index === activeMentionIndex} className={index === activeMentionIndex ? 'mention-suggestion-active' : ''} onPointerDown={(event) => event.preventDefault()} onClick={() => onMentionSelect(member)}><span className="mention-suggestion-avatar">{member.displayName.trim().charAt(0).toUpperCase()}</span><span><b>{member.displayName}</b><small>@{member.username}</small></span></button>)}</div>}
        {filesEnabled && activePicker === 'attach' && <div className="composer-popover attach-popover"><button onClick={() => fileInputRef.current?.click()}><Paperclip size={17} /><span>Upload any file</span><small>Up to 20 GB per file</small></button><div className="upload-limit-note">Any file extension is accepted. Files are downloaded as-is; only common image formats are previewed.</div></div>}
        {emojiEnabled && activePicker === 'emoji' && <div className="composer-popover emoji-popover"><OrbitEmojiPicker mode="compose" onPick={onEmoji} onClose={() => setActivePicker(null)} /></div>}
        {gifEnabled && activePicker === 'gif' && <div className="composer-popover gif-popover"><div className="picker-heading"><div><b>Find a GIF</b><small>{gifSearch.trim() ? 'Search results' : 'Featured GIFs'} · Tenor</small></div><button title="Close picker" onClick={() => setActivePicker(null)}><X size={16} /></button></div><div className="picker-search"><Search size={15} /><input value={gifSearch} onChange={(event) => setGifSearch(event.target.value)} placeholder="Search GIFs" autoFocus /></div>{gifLoading && !gifs.length ? <div className="picker-state"><LoaderCircle size={20} className="spin" /> Searching Tenor…</div> : gifError ? <div className="picker-state picker-error"><Info size={18} /><span>{gifError}</span></div> : gifs.length ? <><div className="gif-grid">{gifs.map((gif) => <button key={gif.id} title={gif.title} onClick={() => onSelectGif(gif)}><img src={gif.previewUrl || gif.url} alt={gif.title} loading="lazy" /></button>)}</div>{gifNext && <button className="gif-load-more" onClick={onLoadMoreGifs} disabled={gifLoading}>{gifLoading ? <LoaderCircle size={14} className="spin" /> : null}{gifLoading ? 'Loading more…' : 'Load more GIFs'}</button>}</> : <div className="picker-state"><Search size={19} /><span>{gifSearch ? 'No GIFs found for that search.' : 'No featured GIFs are available right now.'}</span></div>}<div className="picker-attribution">GIFs provided by Tenor</div></div>}
        {stickersEnabled && activePicker === 'sticker' && <div className="composer-popover sticker-popover"><div className="picker-heading"><div><b>Orbit stickers</b><small>Original Unicode sticker set</small></div><button title="Close picker" onClick={() => setActivePicker(null)}><X size={16} /></button></div><div className="sticker-grid">{stickers.map((sticker) => <button key={sticker.name} title={sticker.name} onClick={() => onSticker(sticker)}><span>{sticker.emoji}</span><small>{sticker.name}</small></button>)}</div></div>}
      </div>
      <button className={`composer-send ${value.trim() || attachments.length || selectedGif ? 'send-ready' : ''}`} onClick={onSend} disabled={disabled || busy || (!value.trim() && !attachments.length && !selectedGif && !editing)} title="Send message (Enter)">{busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}</button>
      {filesEnabled && <input ref={fileInputRef} type="file" multiple className="sr-only" onChange={(event) => { if (event.target.files?.length) void onFiles(event.target.files); }} />}
    </div>
    <div className="composer-hint"><span><b>Enter</b> to send · <b>Shift + Enter</b> for a new line</span><div className="format-actions"><button title="Bold" onClick={() => onFormat('**')}><b>B</b></button><button title="Italic" onClick={() => onFormat('_')}><i>I</i></button><button title="Inline code" onClick={() => onFormat('`')}><code>{'</>'}</code></button><span>{Math.max(0, 4000 - value.length)}</span></div></div>
  </div>;
}

function PencilIcon() { return <PencilSmall />; }
function PencilSmall() { return <span aria-hidden="true">✎</span>; }

function Dialog(props: {
  mode: DialogMode; setMode(mode: DialogMode): void; serverName: string; setServerName(value: string): void; onCreateServer(event: FormEvent): void;
  inviteCode: string; setInviteCode(value: string): void; onJoinServer(event: FormEvent): void; channelName: string; setChannelName(value: string): void;
  channelType: 'text'|'voice'; setChannelType(value: 'text'|'voice'): void; topic: string; setTopic(value: string): void; channelCategoryId: string; setChannelCategoryId(value: string): void;
  categories: Category[]; onCreateChannel(event: FormEvent): void; categoryName: string; setCategoryName(value: string): void; onCreateCategory(event: FormEvent): void;
  inviteLink: string; activeServer: Server | null; user: User; theme: ThemeMode; setTheme(value: ThemeMode): void; fontScale: number; setFontScale(value: number): void;
  desktopNotifications: boolean; setDesktopNotifications(value: boolean): void; reducedMotion: boolean; setReducedMotion(value: boolean): void; voiceSounds: boolean; setVoiceSounds(value: boolean): void; sidebarCollapsed: boolean; setSidebarCollapsed(value: boolean): void;
  onLogout(): void; runtime: Runtime | null; apiUrl: string; token: string; notify(text: string): void; busy: boolean; onProfileChange(user: User): void;
  audioDevices: MediaDeviceInfo[]; voiceInputDeviceId: string; setVoiceInputDeviceId(value: string): void; voiceOutputDeviceId: string; setVoiceOutputDeviceId(value: string): void; onSelectInputDevice(value: string): void; onSelectOutputDevice(value: string): void;
}) {
  const { mode, setMode } = props;
  const [displayName, setDisplayName] = useState(props.user.displayName);
  const [about, setAbout] = useState(props.user.about);
  const [status, setStatus] = useState<User['status']>(props.user.status);
  const [avatarHistory, setAvatarHistory] = useState<AvatarHistoryItem[]>([]);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState('');
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const close = () => setMode(null);
  const themeChoices: ThemeMode[] = ['dark', 'light', 'system'];
  useEffect(() => {
    if (mode !== 'profile') return;
    let disposed = false;
    let localItems: AvatarHistoryItem[] = [];
    void apiRequest<{ avatars: AvatarHistoryItem[] }>(props.apiUrl, props.token, '/api/me/avatars').then(async (result) => {
      const local = await readLocalAvatarHistory(props.user.id);
      localItems = local;
      if (disposed) local.forEach((item) => URL.revokeObjectURL(item.url));
      else setAvatarHistory([...local, ...result.avatars.filter((item) => !local.some((saved) => saved.id.endsWith(`:${item.id}`)))]);
    }).catch((error) => props.notify(error instanceof Error ? error.message : 'Avatar history could not be loaded.'));
    return () => { disposed = true; localItems.forEach((item) => { if (item.url) URL.revokeObjectURL(item.url); }); };
  }, [mode, props.apiUrl, props.token, props.user.id]);
  useEffect(() => {
    if (!avatarFile) { setAvatarPreview(''); return; }
    const url = URL.createObjectURL(avatarFile);
    setAvatarPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);
  const chooseAvatar = (file?: File) => {
    if (!file) return;
    const supported = ['image/jpeg', 'image/png', 'image/gif'];
    if (!supported.includes(file.type.toLowerCase()) || file.size > 8 * 1024 * 1024) {
      props.notify(file.size > 8 * 1024 * 1024 ? 'Avatar files must be 8 MB or smaller.' : 'Choose a JPEG, PNG, or GIF image.');
      return;
    }
    setAvatarFile(file);
    setAvatarZoom(1);
  };
  const saveAvatar = async () => {
    if (!avatarFile || avatarBusy) return;
    setAvatarBusy(true);
    try {
      const image = avatarFile;
      const form = new FormData(); form.append('avatar', avatarFile); form.append('zoom', String(avatarZoom));
      const result = await apiRequest<{ user: User; avatar: AvatarHistoryItem }>(props.apiUrl, props.token, '/api/me/avatar', { method: 'POST', body: form });
      props.onProfileChange(result.user);
      const local = { ...result.avatar, id: `${props.user.id}:${result.avatar.id}`, local: false };
      setAvatarHistory((current) => [local, ...current.filter((item) => item.id !== local.id)]);
      setAvatarFile(null);
      try {
        await saveLocalAvatarBackup({ id: local.id, image, contentType: result.avatar.contentType, zoom: result.avatar.zoom, createdAt: result.avatar.createdAt });
        props.notify('Avatar saved to your server and local history.');
      } catch { props.notify('Avatar saved to the server. Local backup is unavailable on this device.'); }
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Avatar could not be saved.'); }
    finally { setAvatarBusy(false); }
  };
  const restoreAvatar = async (avatar: AvatarHistoryItem) => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      if (avatar.local) {
        const saved = await getLocalAvatarBackup(avatar.id);
        if (!saved) throw new Error('This local avatar backup is unavailable.');
        const form = new FormData(); form.append('avatar', saved.image, 'restored-avatar'); form.append('zoom', String(saved.zoom));
        const uploaded = await apiRequest<{ user: User; avatar: AvatarHistoryItem }>(props.apiUrl, props.token, '/api/me/avatar', { method: 'POST', body: form });
        props.onProfileChange(uploaded.user);
        const local = { ...uploaded.avatar, id: `${props.user.id}:${uploaded.avatar.id}`, local: false };
        setAvatarHistory((current) => [local, ...current.filter((item) => item.id !== local.id)]);
        props.notify('Avatar restored from your local backup.');
        return;
      }
      const result = await apiRequest<{ user: User }>(props.apiUrl, props.token, `/api/me/avatar/${encodeURIComponent(avatar.id)}`, { method: 'PATCH', body: JSON.stringify({}) });
      props.onProfileChange(result.user);
      props.notify('Avatar restored from history.');
    } catch (error) { props.notify(error instanceof Error ? error.message : 'Avatar could not be restored.'); }
    finally { setAvatarBusy(false); }
  };
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    try { const response = await apiRequest<{user:User}>(props.apiUrl, props.token, '/api/me', { method:'PATCH', body:JSON.stringify({displayName,about,status}) }); window.dispatchEvent(new CustomEvent('orbit:profile', {detail:response.user})); props.notify('Profile updated.'); close(); }
    catch (error) { props.notify(error instanceof Error ? error.message : 'Profile could not be updated.'); }
  };
  const copyInvite = async () => {
    try { await window.orbit.writeClipboard(props.inviteLink); props.notify('Invite code copied.'); }
    catch (error) { props.notify(error instanceof Error ? error.message : 'Invite code could not be copied.'); }
  };
  const enableNotifications = async () => { if (!('Notification' in window)) return; const permission = await Notification.requestPermission(); props.setDesktopNotifications(permission === 'granted'); };
  return <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }} onContextMenu={(event) => { if (mode === 'profile' && event.target === event.currentTarget) { event.preventDefault(); close(); } }} onKeyDown={(event) => { if (event.key === 'Escape') close(); }}><div className={`modal-card ${mode === 'settings' ? 'settings-modal' : ''} ${mode === 'profile' ? 'profile-modal' : ''}`} role="dialog" aria-modal="true">
    {mode !== 'profile' && <button className="modal-close" title="Close" onClick={close}><X size={19} /></button>}
    {mode === 'server' && <><div className="modal-icon"><Logo /></div><h2>Create your server</h2><p>Give your community a name. You’ll be the owner and can invite people when you’re ready.</p><form onSubmit={props.onCreateServer}><label>Server name<input autoFocus value={props.serverName} onChange={(event) => props.setServerName(event.target.value)} minLength={2} maxLength={64} required placeholder="e.g. Stargazers" /></label><div className="modal-actions"><button type="button" className="button-subtle" onClick={close}>Cancel</button><button className="button-primary" disabled={props.busy}>{props.busy ? 'Creating…' : 'Create server'}</button></div></form></>}
    {mode === 'join' && <><div className="modal-icon"><Compass size={27} /></div><h2>Join a server</h2><p>Paste an invite code shared by someone in the community.</p><form onSubmit={props.onJoinServer}><label>Invite code<input autoFocus value={props.inviteCode} onChange={(event) => props.setInviteCode(event.target.value)} maxLength={32} required placeholder="Paste invite code" /></label><div className="modal-actions"><button type="button" className="button-subtle" onClick={close}>Cancel</button><button className="button-primary" disabled={props.busy}>{props.busy ? 'Joining…' : 'Join server'}</button></div></form></>}
    {mode === 'channel' && <><div className="modal-icon"><Hash size={26} /></div><h2>Create a channel</h2><p>New channels are available to all members in {props.activeServer?.name}.</p><form onSubmit={props.onCreateChannel}><div className="channel-kind-switch"><button type="button" className={props.channelType === 'text' ? 'active' : ''} onClick={() => props.setChannelType('text')}><Hash size={15} /> Text</button><button type="button" className={props.channelType === 'voice' ? 'active' : ''} onClick={() => props.setChannelType('voice')}><Volume2 size={15} /> Voice</button></div><label>Channel name<input autoFocus value={props.channelName} onChange={(event) => props.setChannelName(event.target.value)} maxLength={64} required placeholder="new-channel" /></label><label>Category<select value={props.channelCategoryId} onChange={(event) => props.setChannelCategoryId(event.target.value)}><option value="">No category</option>{props.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>{props.channelType === 'text' && <label>Topic (optional)<input value={props.topic} onChange={(event) => props.setTopic(event.target.value)} maxLength={200} placeholder="What is this channel for?" /></label>}<div className="modal-actions"><button type="button" className="button-subtle" onClick={close}>Cancel</button><button className="button-primary" disabled={props.busy}>{props.busy ? 'Creating…' : 'Create channel'}</button></div></form></>}
    {mode === 'category' && <><div className="modal-icon"><FolderPlus size={25} /></div><h2>Create a category</h2><p>Categories keep related text and voice channels together in {props.activeServer?.name}.</p><form onSubmit={props.onCreateCategory}><label>Category name<input autoFocus value={props.categoryName} onChange={(event) => props.setCategoryName(event.target.value)} maxLength={64} required placeholder="e.g. Game nights" /></label><div className="modal-actions"><button type="button" className="button-subtle" onClick={close}>Cancel</button><button className="button-primary" disabled={props.busy || !props.categoryName.trim()}>{props.busy ? 'Creating…' : 'Create category'}</button></div></form></>}
    {mode === 'invite' && <><div className="modal-icon"><Plus size={25} /></div><h2>Invite to {props.activeServer?.name}</h2><p>This invite has no expiry date. Share it only with people you want in this server.</p><div className="invite-copy-row"><code>{props.inviteLink}</code><button className="button-primary" onClick={() => void copyInvite()}><Copy size={15} /> Copy</button></div><div className="modal-actions"><button className="button-subtle" onClick={close}>Done</button></div></>}
    {mode === 'profile' && <section className="avatar-editor">
      <header className="avatar-editor-heading"><div><span>PERSONALIZE YOUR ORBIT</span><h2>Your profile</h2><p>Choose a picture and frame it just right.</p></div><button type="button" className="modal-close" title="Close" aria-label="Close profile editor" onClick={close}><X size={19} /></button></header>
      <div className="avatar-editor-body">
        <section className="avatar-editor-stage" aria-label="Avatar crop and zoom editor">
          <div className="avatar-crop-ring"><span>{avatarPreview ? <img src={avatarPreview} alt="Avatar preview" style={{ transform: `scale(${avatarZoom})` }} /> : <Avatar label={props.user.displayName} url={props.user.avatarUrl} size="large" status={status} />}</span><i /></div>
          <strong>{displayName || props.user.displayName}</strong><small>@{props.user.username}</small>
          <div className="avatar-zoom-control"><span>ZOOM</span><input aria-label="Avatar zoom" type="range" min="1" max="3" step="0.05" value={avatarZoom} onChange={(event) => setAvatarZoom(Number(event.target.value))} /><b>{avatarZoom.toFixed(1)}×</b></div>
          <p className="avatar-editor-hint">Adjust the centered crop with the zoom slider. Animated GIFs stay animated.</p>
          <input ref={avatarInputRef} className="sr-only" type="file" accept="image/jpeg,image/png,image/gif,.jpg,.jpeg,.png,.gif" onChange={(event) => { chooseAvatar(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
          <div className="avatar-editor-actions"><button type="button" className="button-subtle" onClick={() => avatarInputRef.current?.click()}><Image size={15} /> Choose image</button><button type="button" className="button-primary" disabled={!avatarFile || avatarBusy} onClick={() => void saveAvatar()}>{avatarBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{avatarBusy ? ' Saving…' : ' Save avatar'}</button></div>
          <small className="avatar-format-note">JPEG, PNG or animated GIF · up to 8 MB</small>
        </section>
       <form className="avatar-profile-fields" onSubmit={(event) => void saveProfile(event)}><h3>Profile details</h3><label>Display name<input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={48} required /></label><label>About me<textarea value={about} onChange={(event) => setAbout(event.target.value)} maxLength={190} rows={2} placeholder="A little about you" /></label><label>Online status<select value={status} onChange={(event) => setStatus(event.target.value as User['status'])}><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do not disturb</option><option value="invisible">Invisible</option></select></label><div className="profile-username">Username <b>@{props.user.username}</b></div><div className="modal-actions"><button type="button" className="button-subtle" onClick={close}>Cancel</button><button className="button-primary">Save profile</button></div></form>
      </div>
      <section className="avatar-history"><header><div><h3>Avatar history</h3><small>Restore any picture you’ve used before.</small></div><span>{avatarHistory.length} saved</span></header>{avatarHistory.length ? <div className="avatar-history-list">{avatarHistory.map((item) => <button key={item.id} type="button" className={`avatar-history-item ${props.user.avatarUrl?.includes(item.id.split(':').at(-1) ?? item.id) ? 'selected' : ''}`} title={`Restore avatar from ${new Date(item.createdAt).toLocaleDateString()}`} disabled={avatarBusy} onClick={() => void restoreAvatar(item)}><span className="avatar-history-ring"><img src={item.local ? item.url : resolveServerAssetUrl(props.apiUrl, item.url)} alt="" style={{ transform: `scale(${item.zoom})` }} /></span><small>{props.user.avatarUrl?.includes(item.id.split(':').at(-1) ?? item.id) ? 'CURRENT' : new Date(item.createdAt).toLocaleDateString()}</small></button>)}</div> : <p className="avatar-history-empty">Your saved avatars will appear here after you choose one.</p>}</section>
    </section>}
    {mode === 'settings' && <><div className="settings-heading"><div className="modal-icon"><Settings size={24} /></div><div><h2>Preferences</h2><p>Make Orbit Chat comfortable for you.</p></div></div><div className="settings-body"><section className="settings-section"><h3>Appearance</h3><div className="theme-options">{themeChoices.map((choice) => <button key={choice} className={props.theme === choice ? 'selected' : ''} onClick={() => props.setTheme(choice)}>{choice === 'dark' ? <Moon size={17} /> : choice === 'light' ? <Sun size={17} /> : <Zap size={17} />}{choice[0].toUpperCase()+choice.slice(1)}{props.theme === choice && <Check size={15} />}</button>)}</div><label className="range-setting"><span>Text size <b>{props.fontScale}%</b></span><input type="range" min="90" max="120" step="5" value={props.fontScale} onChange={(event) => props.setFontScale(Number(event.target.value))} /></label><ToggleSetting title="Reduce motion" detail="Use fewer animated transitions." checked={props.reducedMotion} onChange={props.setReducedMotion} /><ToggleSetting title="Voice connection sounds" detail="Play a soft cue when you join or leave voice." checked={props.voiceSounds} onChange={props.setVoiceSounds} /><ToggleSetting title="Collapse channel sidebar" detail="Give the conversation more room." checked={props.sidebarCollapsed} onChange={props.setSidebarCollapsed} /></section><section className="settings-section"><h3>Voice & audio</h3><label>Microphone<select value={props.voiceInputDeviceId} onChange={(event) => { props.setVoiceInputDeviceId(event.target.value); void props.onSelectInputDevice(event.target.value); }}><option value="">Default microphone</option>{props.audioDevices.filter((device) => device.kind === 'audioinput').map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${device.deviceId.slice(0, 6)}`}</option>)}</select></label><label>Speaker<select value={props.voiceOutputDeviceId} onChange={(event) => { props.setVoiceOutputDeviceId(event.target.value); void props.onSelectOutputDevice(event.target.value); }}><option value="">Default speaker</option>{props.audioDevices.filter((device) => device.kind === 'audiooutput').map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${device.deviceId.slice(0, 6)}`}</option>)}</select></label><small className="device-setting-hint">Allow microphone access to show device names. The list refreshes when devices change; speaker routing depends on Electron support.</small></section><section className="settings-section"><h3>Notifications</h3><ToggleSetting title="Desktop notifications" detail={"Show operating-system alerts when you aren't viewing the app."} checked={props.desktopNotifications} onChange={(enabled) => { if (enabled) void enableNotifications(); else props.setDesktopNotifications(false); }} /></section><section className="settings-section"><h3>Account</h3><div className="account-setting"><Avatar label={props.user.displayName} url={props.user.avatarUrl} size="small" status={status} /><div><b>{displayName || props.user.displayName}</b><small>@{props.user.username}</small></div><button className="button-subtle" onClick={() => { close(); props.onLogout(); }}>Log out</button></div></section><section className="settings-section about-section"><h3>About Orbit Chat</h3><p>Desktop {props.runtime?.version} · API port {props.runtime?.port ?? "—"}</p><p>Data folder <b>{props.runtime?.userDataPath ?? "Unavailable"}</b></p><p>{props.runtime?.encryptionAvailable ? "Saved sessions are protected by this Windows profile." : "Secure session storage is unavailable on this system."}</p><p>Messages and files are stored on the server you connect to.</p></section></div><div className="settings-footer"><span>Orbit Chat Preferences</span><button onClick={close}>Done</button></div></>}
  </div></div>;
}

function ChannelSettingsDialog({ channel, busy, onClose, onSave }: {
  channel: Channel; busy: boolean; onClose(): void; onSave(event: FormEvent<HTMLFormElement>, name: string, topic: string): void;
}) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal-card channel-settings-card" role="dialog" aria-modal="true" aria-labelledby="channel-settings-title" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } }}>
      <button className="modal-close" title="Close" aria-label="Close channel settings" disabled={busy} onClick={onClose}><X size={19} /></button>
      <div className="modal-icon">{channel.type === 'voice' ? <Volume2 size={25} /> : <Hash size={25} />}</div>
      <h2 id="channel-settings-title">Channel settings</h2>
      <p>Update the name and topic for this {channel.type === 'voice' ? 'voice' : 'text'} channel.</p>
      <form onSubmit={(event) => onSave(event, name, topic)}>
        <label>Channel name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={64} required /></label>
        <label>Topic<input value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={200} placeholder="What is this channel for?" /></label>
        <div className="modal-actions"><button type="button" className="button-subtle" onClick={onClose} disabled={busy}>Cancel</button><button className="button-primary" disabled={busy || !name.trim()}>{busy ? <><LoaderCircle size={15} className="spin" /> Saving…</> : 'Save changes'}</button></div>
      </form>
    </section>
  </div>;
}

function ConfirmDialog({ action, busy, onClose, onConfirm }: { action: ConfirmAction; busy: boolean; onClose(): void; onConfirm(): void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const isMessage = action.kind === 'message';
  const title = isMessage ? 'Delete message' : 'Delete channel';
  const description = isMessage
    ? 'This message will be marked as deleted for everyone in this conversation.'
    : `Deleting #${action.channel.name} will also remove its messages.`;
  const message = isMessage ? action.message : null;
  const messagePreview = message?.content.trim()
    || (message?.kind === 'sticker' ? `Sticker ${message.stickerEmoji ?? ''}`.trim() : '')
    || (message?.kind === 'gif' ? 'Shared a GIF' : '')
    || (message?.attachments.length ? `${message.attachments.length} attachment${message.attachments.length === 1 ? '' : 's'}` : '')
    || 'Message with no text';

  useEffect(() => { cancelRef.current?.focus(); }, []);

  const close = () => { if (!busy) onClose(); };
  return <div className="app-confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="app-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-description" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <div className="app-confirm-heading">
        <span className="app-confirm-icon">{isMessage ? <Trash2 size={19} /> : <Hash size={19} />}</span>
        <span className="app-confirm-title"><small>ARE YOU SURE?</small><h2 id="confirm-dialog-title">{title}</h2></span>
        <button className="app-confirm-close" type="button" title="Close" aria-label="Close confirmation" disabled={busy} onClick={close}><X size={19} /></button>
      </div>
      <p className="app-confirm-description" id="confirm-dialog-description">{description} <b>This can’t be undone.</b></p>
      {message && <div className="confirm-message-preview">
        <Avatar label={message.authorName} url={message.avatarUrl} size="small" />
        <div className="confirm-message-body"><div><b>{message.authorName}</b><time>{messageTime(message.createdAt)}</time></div><p>{messagePreview}</p>
          {message.attachments.length > 0 && <small>{message.attachments.length} attachment{message.attachments.length === 1 ? '' : 's'}</small>}
        </div>
      </div>}
      {!message && action.kind === 'channel' && <div className="confirm-channel-preview"><span><Hash size={18} /></span><div><b>{action.channel.name}</b><small>{action.channel.type === 'voice' ? 'Voice channel' : 'Text channel'} · its message history will be removed</small></div></div>}
      <footer className="app-confirm-actions">
        <button ref={cancelRef} className="button-subtle" type="button" disabled={busy} onClick={close}>Cancel</button>
        <button className="confirm-delete-button" type="button" disabled={busy} onClick={onConfirm}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{busy ? 'Deleting…' : isMessage ? 'Delete message' : 'Delete channel'}</button>
      </footer>
    </section>
  </div>;
}

function ToggleSetting({ title, detail, checked, onChange, disabled = false }: { title: string; detail: string; checked: boolean; onChange(value: boolean): void; disabled?: boolean }) {
  return <label className={`toggle-setting ${disabled ? 'disabled' : ''}`}><span><b>{title}</b><small>{detail}</small></span><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

export default App;
