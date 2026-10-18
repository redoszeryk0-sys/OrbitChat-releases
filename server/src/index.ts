import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { Server as SocketServer, type Socket } from 'socket.io';
import { z } from 'zod';
import { Database, type Row } from './database';
import { attachmentContentType, MAX_UPLOAD_MB, MAX_UPLOAD_REQUEST_BYTES, UPLOAD_CHUNK_BYTES, mentionMemberIds, resolveUploadLimitBytes, UPLOAD_REQUEST_TIMEOUT_MS } from './uploads';
import type { Category, Message, PublicUser, ServerSummary } from './types';

interface ServerOptions {
  databasePath?: string;
  uploadDir?: string;
  tenorApiKey?: string;
  turnUrl?: string;
  turnUsername?: string;
  turnCredential?: string;
  corsOrigins?: string[];
  maxUploadMb?: number;
  host?: string;
  port?: number;
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

interface AuthUser extends PublicUser { passwordHash?: string }
interface AuthRequest extends Request { user?: AuthUser; authToken?: string }
interface LiveSocket extends Socket { data: { user?: AuthUser } }

const nowIso = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (row: Row): PublicUser => ({
  id: String(row.id), username: String(row.username), displayName: String(row.display_name),
  avatarUrl: row.avatar_url ? String(row.avatar_url) : null, about: String(row.about ?? ''),
  status: String(row.status ?? 'online'), createdAt: String(row.created_at)
});
const normalizeUsername = (username: string) => username.trim().toLowerCase();
const safeFilename = (name: string) => name.replace(/\\/g, '/').split('/').pop()?.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 180) || 'attachment';
const validAvatarImage = (buffer: Buffer, contentType: string) => {
  if (contentType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (contentType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (contentType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  return false;
};
const registerSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  displayName: z.string().trim().min(1).max(48).optional(),
  password: z.string().min(10).max(128)
});
const loginSchema = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) });
const messageSchema = z.object({
  content: z.string().max(4000).default(''),
  kind: z.enum(['text', 'gif', 'sticker']).default('text'),
  stickerEmoji: z.string().max(24).optional(),
  mediaUrl: z.string().url().max(2048).optional(),
  replyToId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
  mentions: z.array(z.string().uuid()).max(100).default([])
}).refine((value) => value.content.trim() !== '' || value.attachmentIds.length > 0 || value.stickerEmoji || value.mediaUrl || (value.kind === 'gif' && value.content), 'A message must have text or media');

export interface OrbitServer {
  app: express.Express;
  httpServer: http.Server;
  io: SocketServer;
  db: Database;
  port: number;
  close(): Promise<void>;
}

export async function createOrbitServer(options: ServerOptions = {}): Promise<OrbitServer> {
  const uploadDir = path.resolve(options.uploadDir ?? process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'data_server', 'uploads'));
  fs.mkdirSync(uploadDir, { recursive: true });
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data_server'));
  const db = await Database.open(options.databasePath ?? path.join(dataDir, 'orbitchat.sqlite'));
  const app = express();
  const httpServer = http.createServer(app);
  httpServer.requestTimeout = UPLOAD_REQUEST_TIMEOUT_MS;
  httpServer.timeout = UPLOAD_REQUEST_TIMEOUT_MS;
  const devOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'null'];
  const allowedOrigins = new Set(options.corsOrigins ?? (process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()) : devOrigins));
  const io = new SocketServer(httpServer, {
    cors: { origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), methods: ['GET', 'POST'] },
    maxHttpBufferSize: 1e6
  });
  const logger = options.logger ?? ((message, details = {}) => console.log(JSON.stringify({ at: nowIso(), message, ...details })));
  const uploadLimit = resolveUploadLimitBytes(options.maxUploadMb === undefined ? process.env.MAX_UPLOAD_MB : String(options.maxUploadMb));

  app.disable('x-powered-by');
  app.use(cors({
    origin(origin, callback) { callback(null, !origin || allowedOrigins.has(origin)); },
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Upload-Offset'], methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']
  }));
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, name: 'OrbitChat Server', version: '0.1.0', time: nowIso() }));

  const requireAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const match = header?.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
    if (!match) return res.status(401).json({ error: 'Sign in to continue.' });
    const row = db.one<Row & { user_id: string }>(
      `SELECT u.*,s.id AS session_id,s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
      [tokenHash(match[1]), nowIso()]
    );
    if (!row) return res.status(401).json({ error: 'Your session has expired. Sign in again.' });
    req.user = { ...publicUser(row), passwordHash: String(row.password_hash) };
    req.authToken = match[1];
    return next();
  };
  const auth = (req: Request, res: Response, next: NextFunction) => requireAuth(req as AuthRequest, res, next);
  const authRateLimit = rateLimit({ windowMs: 15 * 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many sign-in attempts. Try again later.' } });
  const getUser = (req: Request) => (req as AuthRequest).user!;
  const routeParam = (req: Request, key: string): string => {
    const value = req.params[key];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  };
  const isMember = (serverId: string, userId: string) => Boolean(db.one('SELECT 1 AS yes FROM members WHERE server_id=? AND user_id=?', [serverId, userId]));
  const canManage = (serverId: string, userId: string) => Boolean(db.one('SELECT 1 AS yes FROM members WHERE server_id=? AND user_id=? AND role IN (\'owner\',\'admin\')', [serverId, userId]));
  const canReadChannel = (channelId: string, userId: string) => Boolean(db.one(
    `SELECT 1 AS yes FROM channels c JOIN members m ON m.server_id=c.server_id WHERE c.id=? AND m.user_id=? AND (c.is_private=0 OR c.id IN (SELECT channel_id FROM channel_members WHERE user_id=?))`,
    [channelId, userId, userId]
  ));

  db.run(`CREATE TABLE IF NOT EXISTS channel_members (channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(channel_id,user_id))`);

  const userWithPassword = (username: string) => db.one<Row>(
    'SELECT * FROM users WHERE username_norm=?', [normalizeUsername(username)]
  );
  const makeSession = (userId: string) => {
    const token = crypto.randomBytes(36).toString('base64url');
    db.run('INSERT INTO sessions(id,token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?,?)', [id(), tokenHash(token), userId, new Date(Date.now() + 30 * 86400_000).toISOString(), nowIso()]);
    return token;
  };

  app.post('/api/auth/register', authRateLimit, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the account details.' });
    const body = parsed.data;
    if (userWithPassword(body.username)) return res.status(409).json({ error: 'That username is already in use.' });
    const userId = id();
    const passwordHash = await bcrypt.hash(body.password, 12);
    db.run('INSERT INTO users(id,username,username_norm,display_name,password_hash,created_at) VALUES(?,?,?,?,?,?)', [userId, body.username, normalizeUsername(body.username), body.displayName ?? body.username, passwordHash, nowIso()]);
    const row = db.one<Row>('SELECT * FROM users WHERE id=?', [userId])!;
    return res.status(201).json({ sessionToken: makeSession(userId), user: publicUser(row) });
  });

  app.post('/api/auth/login', authRateLimit, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter your username and password.' });
    const row = userWithPassword(parsed.data.username);
    if (!row || !(await bcrypt.compare(parsed.data.password, String(row.password_hash)))) return res.status(401).json({ error: 'The username or password is incorrect.' });
    return res.json({ sessionToken: makeSession(String(row.id)), user: publicUser(row) });
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: publicUser(db.one('SELECT * FROM users WHERE id=?', [getUser(req).id])!) }));
  app.post('/api/auth/logout', auth, (req, res) => {
    db.run('DELETE FROM sessions WHERE token_hash=?', [tokenHash((req as AuthRequest).authToken!)]);
    return res.json({ ok: true });
  });
  app.patch('/api/me', auth, (req, res) => {
    const parsed = z.object({ displayName: z.string().trim().min(1).max(48).optional(), about: z.string().max(190).optional(), status: z.enum(['online','idle','dnd','invisible']).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check your profile details.' });
    const user = getUser(req);
    const values = parsed.data;
    db.run('UPDATE users SET display_name=COALESCE(?,display_name),about=COALESCE(?,about),status=COALESCE(?,status) WHERE id=?', [values.displayName ?? null, values.about ?? null, values.status ?? null, user.id]);
    const updated = db.one('SELECT * FROM users WHERE id=?', [user.id])!;
    io.emit('presence:changed', publicUser(updated));
    return res.json({ user: publicUser(updated) });
  });

  const avatarTypes = new Set(['image/jpeg', 'image/png', 'image/gif']);
  const avatarLimitBytes = 8 * 1024 * 1024;
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: avatarLimitBytes, files: 1, fields: 1, fieldSize: 32 }
  });
  app.get('/api/me/avatars', auth, (req, res) => {
    const history = db.query<Row>('SELECT id,content_type,zoom,created_at FROM avatar_history WHERE user_id=? ORDER BY created_at DESC', [getUser(req).id]);
    return res.json({ avatars: history.map((item) => ({ id: String(item.id), contentType: String(item.content_type), zoom: Number(item.zoom), createdAt: String(item.created_at), url: `/api/avatars/${String(item.id)}?zoom=${Number(item.zoom)}` })) });
  });
  app.post('/api/me/avatar', auth, (req, res) => {
    avatarUpload.single('avatar')(req, res, (error) => {
      if (error) return res.status(error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 'Avatars must be 8 MB or smaller.' : 'Choose one JPEG, PNG, or GIF image.' });
      const file = (req as Request & { file?: Express.Multer.File }).file;
      if (!file) return res.status(400).json({ error: 'Choose a JPEG, PNG, or GIF avatar.' });
      const contentType = file.mimetype.toLowerCase();
      if (!avatarTypes.has(contentType) || !validAvatarImage(file.buffer, contentType)) return res.status(400).json({ error: 'Avatar must be a valid JPEG, PNG, or GIF image.' });
      const zoomResult = z.coerce.number().min(1).max(3).safeParse(req.body?.zoom ?? 1);
      if (!zoomResult.success) return res.status(400).json({ error: 'Avatar zoom must be between 1× and 3×.' });
      const user = getUser(req), contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const current = db.one<Row>('SELECT id FROM avatar_history WHERE user_id=? AND content_hash=?', [user.id, contentHash]);
      let avatarId = current ? String(current.id) : id();
      if (!current) {
        const storageName = `avatar-${crypto.randomUUID()}.${contentType === 'image/jpeg' ? 'jpg' : contentType === 'image/png' ? 'png' : 'gif'}`;
        try { fs.writeFileSync(path.join(uploadDir, storageName), file.buffer, { flag: 'wx' }); }
        catch { return res.status(500).json({ error: 'The avatar could not be saved.' }); }
        db.run('INSERT INTO avatar_history(id,user_id,storage_name,content_type,content_hash,zoom,created_at) VALUES(?,?,?,?,?,?,?)', [avatarId, user.id, storageName, contentType, contentHash, zoomResult.data, nowIso()]);
      }
      const zoom = zoomResult.data;
      db.run('UPDATE avatar_history SET zoom=?,created_at=? WHERE id=? AND user_id=?', [zoom, nowIso(), avatarId, user.id]);
      db.run('UPDATE users SET avatar_url=? WHERE id=?', [`/api/avatars/${avatarId}?zoom=${zoom}`, user.id]);
      const updated = db.one<Row>('SELECT * FROM users WHERE id=?', [user.id])!;
      io.emit('presence:changed', publicUser(updated));
      return res.json({ user: publicUser(updated), avatar: { id: avatarId, contentType, zoom, createdAt: nowIso(), url: `/api/avatars/${avatarId}?zoom=${zoom}` } });
    });
  });
  app.patch('/api/me/avatar/:avatarId', auth, (req, res) => {
    const user = getUser(req), avatarId = routeParam(req, 'avatarId');
    const avatar = db.one<Row>('SELECT id,zoom FROM avatar_history WHERE id=? AND user_id=?', [avatarId, user.id]);
    if (!avatar) return res.status(404).json({ error: 'That avatar is not in your history.' });
    db.run('UPDATE users SET avatar_url=? WHERE id=?', [`/api/avatars/${avatarId}?zoom=${Number(avatar.zoom)}`, user.id]);
    const updated = db.one<Row>('SELECT * FROM users WHERE id=?', [user.id])!;
    io.emit('presence:changed', publicUser(updated));
    return res.json({ user: publicUser(updated) });
  });
  app.get('/api/avatars/:avatarId', (req, res) => {
    const avatar = db.one<Row>('SELECT * FROM avatar_history WHERE id=?', [routeParam(req, 'avatarId')]);
    if (!avatar) return res.status(404).json({ error: 'Avatar not found.' });
    const filePath = path.join(uploadDir, path.basename(String(avatar.storage_name)));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Avatar image is unavailable.' });
    res.setHeader('Content-Type', String(avatar.content_type));
    res.setHeader('Content-Length', fs.statSync(filePath).size);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(filePath);
  });

  app.get('/api/bootstrap', auth, (req, res) => {
    const user = getUser(req);
    const rows = db.query<Row & { server_id: string; role: string; owner_id: string }>(
      `SELECT s.*,m.role FROM servers s JOIN members m ON s.id=m.server_id WHERE m.user_id=? ORDER BY s.created_at`, [user.id]
    );
    const servers: ServerSummary[] = rows.map((row) => ({
      id: String(row.id), name: String(row.name), icon: row.icon ? String(row.icon) : null,
      ownerId: String(row.owner_id), role: String(row.role),
      categories: db.query('SELECT id,server_id AS serverId,name,position FROM categories WHERE server_id=? ORDER BY position', [String(row.id)]) as unknown as Category[],
      channels: db.query(`SELECT id,server_id AS serverId,category_id AS categoryId,name,type,topic,position FROM channels WHERE server_id=? ORDER BY position`, [String(row.id)]) as unknown as ServerSummary['channels']
    }));
    return res.json({ user: publicUser(db.one('SELECT * FROM users WHERE id=?', [user.id])!), servers });
  });

  app.post('/api/servers', auth, (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(64) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Server names must have 2 to 64 characters.' });
    const owner = getUser(req);
    const serverId = id(), categoryId = id(), textId = id(), voiceId = id(), inviteCode = crypto.randomBytes(7).toString('base64url');
    db.transaction((execute) => {
      execute('INSERT INTO servers(id,name,owner_id,created_at) VALUES(?,?,?,?)', [serverId, parsed.data.name, owner.id, nowIso()]);
      execute('INSERT INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [serverId, owner.id, 'owner', nowIso()]);
      execute('INSERT INTO categories(id,server_id,name,position) VALUES(?,?,?,?)', [categoryId, serverId, 'Text Channels', 0]);
      execute('INSERT INTO channels(id,server_id,category_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?,?)', [textId, serverId, categoryId, 'general', 'text', '', 0, nowIso()]);
      execute('INSERT INTO channels(id,server_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?)', [voiceId, serverId, 'Lounge', 'voice', '', 1, nowIso()]);
      execute('INSERT INTO invites(code,server_id,creator_id) VALUES(?,?,?)', [inviteCode, serverId, owner.id]);
      execute('INSERT INTO audit_log(id,server_id,actor_id,action,target_id,created_at) VALUES(?,?,?,?,?,?)', [id(), serverId, owner.id, 'server.create', serverId, nowIso()]);
    });
    const server = db.one('SELECT * FROM servers WHERE id=?', [serverId])!;
    const categories = db.query('SELECT id,server_id AS serverId,name,position FROM categories WHERE server_id=? ORDER BY position', [serverId]);
    const channels = db.query('SELECT id,server_id AS serverId,category_id AS categoryId,name,type,topic,position FROM channels WHERE server_id=? ORDER BY position', [serverId]);
    io.to(`user:${owner.id}`).emit('server:created', { id: serverId, name: parsed.data.name });
    return res.status(201).json({ server: { ...server, role: 'owner', categories, channels }, inviteCode });
  });

  app.post('/api/servers/join', auth, (req, res) => {
    const parsed = z.object({ inviteCode: z.string().trim().min(4).max(32) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid invite code.' });
    const invite = db.one<Row>('SELECT * FROM invites WHERE code=?', [parsed.data.inviteCode]);
    if (!invite || (invite.expires_at && String(invite.expires_at) < nowIso()) || (invite.max_uses && Number(invite.uses) >= Number(invite.max_uses))) return res.status(404).json({ error: 'This invite is expired or no longer available.' });
    const user = getUser(req);
    db.run('INSERT OR IGNORE INTO members(server_id,user_id,role,joined_at) VALUES(?,?,?,?)', [String(invite.server_id), user.id, 'member', nowIso()]);
    db.run('UPDATE invites SET uses=uses+1 WHERE code=?', [parsed.data.inviteCode]);
    io.to(`user:${user.id}`).emit('server:joined', { serverId: String(invite.server_id) });
    return res.json({ serverId: String(invite.server_id) });
  });

  app.post('/api/servers/:serverId/invites', auth, (req, res) => {
    const user = getUser(req), serverId = routeParam(req, 'serverId');
    if (!isMember(serverId, user.id)) return res.status(403).json({ error: 'You are not a member of this server.' });
    const code = crypto.randomBytes(7).toString('base64url');
    db.run('INSERT INTO invites(code,server_id,creator_id,expires_at,max_uses) VALUES(?,?,?,?,?)', [code, serverId, user.id, req.body?.expiresInHours ? new Date(Date.now() + Math.min(168, Number(req.body.expiresInHours)) * 3600_000).toISOString() : null, req.body?.maxUses ? Math.min(100, Number(req.body.maxUses)) : null]);
    return res.status(201).json({ code });
  });

  app.post('/api/servers/:serverId/channels', auth, (req, res) => {
    const user = getUser(req), serverId = routeParam(req, 'serverId');
    if (!canManage(serverId, user.id)) return res.status(403).json({ error: 'Only server owners and administrators can create channels.' });
    const parsed = z.object({ name: z.string().trim().min(1).max(64).regex(/^[\p{L}\p{N}_-]+$/u), type: z.enum(['text','voice','announcement']).default('text'), topic: z.string().max(200).default(''), categoryId: z.string().uuid().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check the channel name and details.' });
    if (parsed.data.categoryId && !db.one('SELECT 1 AS yes FROM categories WHERE id=? AND server_id=?', [parsed.data.categoryId, serverId])) return res.status(400).json({ error: 'The selected category does not belong to this server.' });
    const channelId = id();
    const position = Number(db.one('SELECT COALESCE(MAX(position),-1)+1 AS p FROM channels WHERE server_id=?', [serverId])?.p ?? 0);
    db.run('INSERT INTO channels(id,server_id,category_id,name,type,topic,position,created_at) VALUES(?,?,?,?,?,?,?,?)', [channelId, serverId, parsed.data.categoryId ?? null, parsed.data.name, parsed.data.type, parsed.data.topic, position, nowIso()]);
    const channel = db.one('SELECT id,server_id AS serverId,category_id AS categoryId,name,type,topic,position FROM channels WHERE id=?', [channelId]);
    io.to(`server:${serverId}`).emit('channel:created', channel);
    return res.status(201).json({ channel });
  });

  app.post('/api/servers/:serverId/categories', auth, (req, res) => {
    const user = getUser(req), serverId = routeParam(req, 'serverId');
    if (!canManage(serverId, user.id)) return res.status(403).json({ error: 'Only server owners and administrators can create categories.' });
    const parsed = z.object({ name: z.string().trim().min(1).max(64) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Category names must have 1 to 64 characters.' });
    const categoryId = id();
    const position = Number(db.one('SELECT COALESCE(MAX(position),-1)+1 AS p FROM categories WHERE server_id=?', [serverId])?.p ?? 0);
    db.run('INSERT INTO categories(id,server_id,name,position) VALUES(?,?,?,?)', [categoryId, serverId, parsed.data.name, position]);
    const category = db.one('SELECT id,server_id AS serverId,name,position FROM categories WHERE id=?', [categoryId]);
    io.to(`server:${serverId}`).emit('category:created', category);
    return res.status(201).json({ category });
  });

  app.patch('/api/channels/:channelId', auth, (req, res) => {
    const channelId = routeParam(req, 'channelId');
    const channel = db.one<Row>('SELECT * FROM channels WHERE id=?', [channelId]);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    if (!canManage(String(channel.server_id), getUser(req).id)) return res.status(403).json({ error: 'You cannot edit this channel.' });
    const parsed = z.object({ name: z.string().trim().min(1).max(64).optional(), topic: z.string().max(200).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check the channel details.' });
    db.run('UPDATE channels SET name=COALESCE(?,name),topic=COALESCE(?,topic) WHERE id=?', [parsed.data.name ?? null, parsed.data.topic ?? null, channelId]);
    const updated = db.one('SELECT id,server_id AS serverId,category_id AS categoryId,name,type,topic,position FROM channels WHERE id=?', [channelId]);
    io.to(`server:${channel.server_id}`).emit('channel:updated', updated);
    return res.json({ channel: updated });
  });

  app.delete('/api/channels/:channelId', auth, (req, res) => {
    const channelId = routeParam(req, 'channelId');
    const channel = db.one<Row>('SELECT * FROM channels WHERE id=?', [channelId]);
    if (!channel) return res.status(404).json({ error: 'Channel not found.' });
    if (!canManage(String(channel.server_id), getUser(req).id)) return res.status(403).json({ error: 'You cannot remove this channel.' });
    if (db.one('SELECT count(*) AS n FROM channels WHERE server_id=?', [channel.server_id])?.n === 1) return res.status(409).json({ error: 'A server must keep at least one channel.' });
    db.run('DELETE FROM channels WHERE id=?', [channelId]);
    io.to(`server:${channel.server_id}`).emit('channel:deleted', { channelId });
    return res.json({ ok: true });
  });

  app.get('/api/servers/:serverId/members', auth, (req, res) => {
    const user = getUser(req), serverId = routeParam(req, 'serverId');
    return res.json({ members: db.query(`SELECT u.id,u.username,u.display_name AS displayName,u.avatar_url AS avatarUrl,u.status,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,u.display_name`, [serverId]) });
  });

  app.get('/api/friends', auth, (req, res) => {
    const user = getUser(req);
    const friends = db.query(`
      SELECT u.id,u.username,u.display_name AS displayName,u.status,'friend' AS relation,NULL AS requestId
      FROM friendships f JOIN users u ON u.id=CASE WHEN f.user_a=? THEN f.user_b ELSE f.user_a END
      WHERE f.user_a=? OR f.user_b=?
      UNION ALL
      SELECT u.id,u.username,u.display_name AS displayName,u.status,'incoming' AS relation,fr.id AS requestId
      FROM friend_requests fr JOIN users u ON u.id=fr.from_user WHERE fr.to_user=? AND fr.status='pending'
      UNION ALL
      SELECT u.id,u.username,u.display_name AS displayName,u.status,'outgoing' AS relation,fr.id AS requestId
      FROM friend_requests fr JOIN users u ON u.id=fr.to_user WHERE fr.from_user=? AND fr.status='pending'
      ORDER BY displayName COLLATE NOCASE`, [user.id, user.id, user.id, user.id, user.id]);
    return res.json({ friends });
  });

  app.post('/api/friend-requests', auth, (req, res) => {
    const parsed = z.object({ username: z.string().trim().min(3).max(32) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid username.' });
    const from = getUser(req), target = userWithPassword(parsed.data.username);
    if (!target) return res.status(404).json({ error: 'No account uses that username.' });
    if (String(target.id) === from.id) return res.status(400).json({ error: 'You cannot add yourself.' });
    const a = from.id < String(target.id) ? from.id : String(target.id), b = from.id < String(target.id) ? String(target.id) : from.id;
    if (db.one('SELECT 1 AS yes FROM friendships WHERE user_a=? AND user_b=?', [a,b])) return res.status(409).json({ error: 'You are already friends.' });
    if (db.one('SELECT 1 AS yes FROM friend_requests WHERE from_user=? AND to_user=? AND status=\'pending\'', [target.id, from.id])) return res.status(409).json({ error: 'They have already sent you a request. Accept it from Pending.' });
    const requestId = id();
    db.run(`INSERT INTO friend_requests(id,from_user,to_user,status,created_at) VALUES(?,?,?,?,?) ON CONFLICT(from_user,to_user) DO UPDATE SET id=excluded.id,status='pending',created_at=excluded.created_at`, [requestId, from.id, String(target.id), 'pending', nowIso()]);
    io.to(`user:${String(target.id)}`).emit('friend:request', { requestId, fromUserId: from.id });
    return res.status(201).json({ ok: true });
  });

  app.post('/api/friend-requests/:requestId', auth, (req, res) => {
    const user = getUser(req), requestId = routeParam(req, 'requestId');
    const parsed = z.object({ accept: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose whether to accept this request.' });
    const friendRequest = db.one<Row>('SELECT * FROM friend_requests WHERE id=? AND to_user=? AND status=\'pending\'', [requestId, user.id]);
    if (!friendRequest) return res.status(404).json({ error: 'Friend request not found.' });
    if (!parsed.data.accept) {
      db.run('UPDATE friend_requests SET status=\'declined\' WHERE id=?', [requestId]);
      io.to(`user:${String(friendRequest.from_user)}`).emit('friend:changed', { userId: user.id });
      return res.json({ ok: true });
    }
    const otherId = String(friendRequest.from_user), a = user.id < otherId ? user.id : otherId, b = user.id < otherId ? otherId : user.id;
    let conversationId = db.one<Row>('SELECT conversation_id FROM dm_pairs WHERE user_a=? AND user_b=?', [a,b])?.conversation_id;
    db.transaction((execute) => {
      execute('UPDATE friend_requests SET status=\'accepted\' WHERE id=?', [requestId]);
      execute('INSERT OR IGNORE INTO friendships(user_a,user_b,created_at) VALUES(?,?,?)', [a,b,nowIso()]);
      if (!conversationId) {
        conversationId = id();
        execute('INSERT INTO dm_conversations(id,created_at) VALUES(?,?)', [conversationId,nowIso()]);
        execute('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [conversationId,user.id]);
        execute('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [conversationId,otherId]);
        execute('INSERT INTO dm_pairs(user_a,user_b,conversation_id) VALUES(?,?,?)', [a,b,conversationId]);
      }
    });
    io.to(`user:${otherId}`).emit('friend:changed', { userId: user.id, conversationId });
    return res.json({ ok: true, conversationId });
  });

  const mapMessage = (row: Row, viewerId: string): Message => {
    const messageId = String(row.id);
    const attachments = db.query<Row>('SELECT a.id,a.original_name,a.content_type,a.size FROM message_attachments ma JOIN attachments a ON a.id=ma.attachment_id WHERE ma.message_id=?', [messageId])
      .map((attachment) => ({ id: String(attachment.id), name: String(attachment.original_name), contentType: String(attachment.content_type), size: Number(attachment.size), url: `/api/attachments/${String(attachment.id)}` }));
    const mentions = (() => { try { const values = JSON.parse(String(row.mentions ?? '[]')) as Array<{ userId?: unknown; username?: unknown; displayName?: unknown }>; return Array.isArray(values) ? values.filter((value): value is { userId: string; username: string; displayName: string } => typeof value?.userId === 'string' && typeof value.username === 'string' && typeof value.displayName === 'string') : []; } catch { return []; } })();
    const reactions = db.query<Row>('SELECT emoji,COUNT(*) AS count,SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS reacted FROM reactions WHERE message_id=? GROUP BY emoji ORDER BY MIN(created_at)', [viewerId, messageId])
      .map((reaction) => ({ emoji: String(reaction.emoji), count: Number(reaction.count), reacted: Number(reaction.reacted) > 0 }));
    return {
      id: messageId, channelId: String(row.channel_id), authorId: String(row.author_id), authorName: String(row.display_name),
      avatarUrl: row.avatar_url ? String(row.avatar_url) : null, content: String(row.deleted_at ? 'This message was deleted.' : row.content),
      mentions,
      kind: String(row.kind) as Message['kind'], stickerEmoji: row.sticker_emoji ? String(row.sticker_emoji) : null,
      mediaUrl: row.media_url ? String(row.media_url) : null,
      conversationId: row.conversation_id ? String(row.conversation_id) : null,
      replyToId: row.reply_to_id ? String(row.reply_to_id) : null, editedAt: row.edited_at ? String(row.edited_at) : null,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null, createdAt: String(row.created_at), attachments, reactions
    };
  };
  const messageQuery = `SELECT m.*,u.display_name,u.avatar_url FROM messages m JOIN users u ON u.id=m.author_id`;
  const isDmMember = (conversationId: string, userId: string) => Boolean(db.one('SELECT 1 AS yes FROM dm_members WHERE conversation_id=? AND user_id=?', [conversationId,userId]));
  const mapDmMessage = (row: Row, viewerId: string) => mapMessage(row, viewerId);

  app.post('/api/dms', auth, (req, res) => {
    const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose a valid account.' });
    const user = getUser(req), targetId = parsed.data.userId;
    if (user.id === targetId) return res.status(400).json({ error: 'You cannot message yourself.' });
    const a = user.id < targetId ? user.id : targetId, b = user.id < targetId ? targetId : user.id;
    if (!db.one('SELECT 1 AS yes FROM friendships WHERE user_a=? AND user_b=?', [a,b])) return res.status(403).json({ error: 'You can only start a direct message with a friend.' });
    let conversationId = db.one<Row>('SELECT conversation_id FROM dm_pairs WHERE user_a=? AND user_b=?', [a,b])?.conversation_id;
    if (!conversationId) {
      conversationId = id();
      db.transaction((execute) => {
        execute('INSERT INTO dm_conversations(id,created_at) VALUES(?,?)', [conversationId!,nowIso()]);
        execute('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [conversationId!,user.id]);
        execute('INSERT INTO dm_members(conversation_id,user_id) VALUES(?,?)', [conversationId!,targetId]);
        execute('INSERT INTO dm_pairs(user_a,user_b,conversation_id) VALUES(?,?,?)', [a,b,conversationId!]);
      });
    }
    return res.json({ conversationId: String(conversationId) });
  });

  app.get('/api/dms/:conversationId/messages', auth, (req, res) => {
    const user = getUser(req), conversationId = routeParam(req,'conversationId');
    if (!isDmMember(conversationId,user.id)) return res.status(403).json({ error: 'You cannot access this conversation.' });
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = db.query<Row>(`${messageQuery} WHERE m.conversation_id=? ${before ? 'AND m.created_at<?' : ''} ORDER BY m.created_at DESC LIMIT ?`, before ? [conversationId,before,limit] : [conversationId,limit]);
    return res.json({ messages: rows.reverse().map((row) => mapDmMessage(row,user.id)), hasMore: rows.length === limit });
  });

  app.post('/api/dms/:conversationId/messages', auth, (req, res) => {
    const user = getUser(req), conversationId = routeParam(req,'conversationId');
    if (!isDmMember(conversationId,user.id)) return res.status(403).json({ error: 'You cannot send a message in this conversation.' });
    const parsed = z.object({ content: z.string().trim().max(4000).default(''), replyToId: z.string().uuid().optional(), attachmentIds: z.array(z.string().uuid()).max(10).default([]) })
      .refine((body) => body.content.length > 0 || body.attachmentIds.length > 0, 'A message must have text or an attachment.')
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the message.' });
    if (parsed.data.replyToId && !db.one('SELECT 1 AS yes FROM messages WHERE id=? AND conversation_id=? AND deleted_at IS NULL', [parsed.data.replyToId,conversationId])) return res.status(400).json({ error: 'The message you are replying to is unavailable.' });
    if (parsed.data.attachmentIds.length) {
      const owned = db.query<Row>(`SELECT id FROM attachments WHERE owner_id=? AND id IN (${parsed.data.attachmentIds.map(() => '?').join(',')})`, [user.id, ...parsed.data.attachmentIds]);
      if (owned.length !== parsed.data.attachmentIds.length) return res.status(400).json({ error: 'One or more attachments are unavailable.' });
    }
    const messageId = id();
    db.transaction((execute) => {
      execute('INSERT INTO messages(id,conversation_id,author_id,content,reply_to_id,created_at) VALUES(?,?,?,?,?,?)', [messageId,conversationId,user.id,parsed.data.content,parsed.data.replyToId ?? null,nowIso()]);
      for (const attachmentId of parsed.data.attachmentIds) execute('INSERT INTO message_attachments(message_id,attachment_id) VALUES(?,?)', [messageId, attachmentId]);
    });
    const row = db.one<Row>(`${messageQuery} WHERE m.id=?`, [messageId])!;
    const message = mapDmMessage(row,user.id);
    io.to(`dm:${conversationId}`).emit('dm:message', message);
    io.to(`dm:${conversationId}`).emit('message:new', message);
    return res.status(201).json({ message });
  });

  app.get('/api/channels/:channelId/messages', auth, (req, res) => {
    const user = getUser(req), channelId = routeParam(req, 'channelId');
    if (!canReadChannel(channelId, user.id)) return res.status(403).json({ error: 'You cannot read this channel.' });
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = db.query<Row>(`${messageQuery} WHERE m.channel_id=? ${before ? 'AND m.created_at<?' : ''} ORDER BY m.created_at DESC LIMIT ?`, before ? [channelId, before, limit] : [channelId, limit]);
    return res.json({ messages: rows.reverse().map((row) => mapMessage(row, user.id)), hasMore: rows.length === limit });
  });

  app.post('/api/channels/:channelId/messages', auth, (req, res) => {
    const user = getUser(req), channelId = routeParam(req, 'channelId');
    if (!canReadChannel(channelId, user.id)) return res.status(403).json({ error: 'You cannot send messages here.' });
    const channel = db.one<Row>('SELECT * FROM channels WHERE id=?', [channelId]);
    if (!channel || channel.type === 'voice') return res.status(400).json({ error: 'This channel does not accept messages.' });
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Check the message.' });
    const body = parsed.data;
    const serverId = String(channel.server_id);
    const mentionedUserIds = mentionMemberIds(body.content, db.query<Row & { id: string; username: string; display_name: string }>('SELECT u.id,u.username,u.display_name FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=?', [serverId]).map((member) => ({ id: String(member.id), username: String(member.username), displayName: String(member.display_name) }))).filter((userId) => userId !== user.id);
    const suppliedMentions = [...new Set(body.mentions)].sort();
    const detectedMentions = [...mentionedUserIds].sort();
    if (suppliedMentions.length !== detectedMentions.length || suppliedMentions.some((userId, index) => userId !== detectedMentions[index])) return res.status(400).json({ error: 'Mentions must match server members named in the message.' });
    const mentions = [...new Set(body.mentions)].map((userId) => {
      const member = db.one<Row>('SELECT username,display_name FROM users WHERE id=?', [userId])!;
      return { userId, username: String(member.username), displayName: String(member.display_name) };
    });
    if (body.kind === 'gif') {
      let url: URL;
      try { url = new URL(body.mediaUrl ?? body.content); } catch { return res.status(400).json({ error: 'Choose a valid GIF.' }); }
      if (url.protocol !== 'https:' || !['media.tenor.com','c.tenor.com','tenor.com','giphy.com','media.giphy.com'].includes(url.hostname)) return res.status(400).json({ error: 'GIF links must come from a supported provider.' });
    }
    if (body.replyToId && !db.one('SELECT 1 AS yes FROM messages WHERE id=? AND channel_id=? AND deleted_at IS NULL', [body.replyToId, channelId])) return res.status(400).json({ error: 'The message you are replying to is unavailable.' });
    if (body.attachmentIds.length) {
      const owned = db.query<Row>(`SELECT id FROM attachments WHERE owner_id=? AND id IN (${body.attachmentIds.map(() => '?').join(',')})`, [user.id, ...body.attachmentIds]);
      if (owned.length !== body.attachmentIds.length) return res.status(400).json({ error: 'One or more attachments are unavailable.' });
    }
    const messageId = id(), createdAt = nowIso();
    db.transaction((execute) => {
      execute('INSERT INTO messages(id,channel_id,author_id,content,kind,sticker_emoji,media_url,reply_to_id,created_at,mentions) VALUES(?,?,?,?,?,?,?,?,?,?)', [messageId, channelId, user.id, body.content, body.kind, body.stickerEmoji ?? null, body.mediaUrl ?? (body.kind === 'gif' ? body.content : null), body.replyToId ?? null, createdAt, JSON.stringify(mentions)]);
      for (const attachmentId of body.attachmentIds) execute('INSERT INTO message_attachments(message_id,attachment_id) VALUES(?,?)', [messageId, attachmentId]);
    });
    const row = db.one<Row>(`${messageQuery} WHERE m.id=?`, [messageId])!;
    const message = mapMessage(row, user.id);
    io.to(`channel:${channelId}`).emit('message:new', message);
    io.to(`server:${channel.server_id}`).emit('message:activity', { channelId, authorId: user.id, messageId });
    for (const mention of mentions) if (mention.userId !== user.id) io.to(`user:${mention.userId}`).emit('message:mention', { channelId, message });
    return res.status(201).json({ message });
  });

  app.patch('/api/messages/:messageId', auth, (req, res) => {
    const messageId = routeParam(req, 'messageId');
    const user = getUser(req), message = db.one<Row>('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [messageId]);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    const channel = db.one<Row>('SELECT server_id FROM channels WHERE id=?', [message.channel_id]);
    if (String(message.author_id) !== user.id && (!channel || !canManage(String(channel.server_id), user.id))) return res.status(403).json({ error: 'You cannot edit this message.' });
    const parsed = z.object({ content: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Messages must contain 1 to 4,000 characters.' });
    db.run('UPDATE messages SET content=?,edited_at=? WHERE id=?', [parsed.data.content, nowIso(), messageId]);
    const row = db.one<Row>(`${messageQuery} WHERE m.id=?`, [messageId])!;
    const updated = mapMessage(row, user.id);
    io.to(message.channel_id ? `channel:${String(message.channel_id)}` : `dm:${String(message.conversation_id)}`).emit(message.channel_id ? 'message:updated' : 'dm:updated', updated);
    return res.json({ message: updated });
  });

  app.delete('/api/messages/:messageId', auth, (req, res) => {
    const messageId = routeParam(req, 'messageId');
    const user = getUser(req), message = db.one<Row>('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [messageId]);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    const channel = db.one<Row>('SELECT server_id FROM channels WHERE id=?', [message.channel_id]);
    if (String(message.author_id) !== user.id && (!channel || !canManage(String(channel.server_id), user.id))) return res.status(403).json({ error: 'You cannot delete this message.' });
    db.run('UPDATE messages SET content=\'\',deleted_at=? WHERE id=?', [nowIso(), messageId]);
    io.to(message.channel_id ? `channel:${String(message.channel_id)}` : `dm:${String(message.conversation_id)}`).emit(message.channel_id ? 'message:deleted' : 'dm:deleted', { messageId });
    return res.json({ ok: true });
  });

  app.post('/api/messages/:messageId/reactions', auth, (req, res) => {
    const messageId = routeParam(req, 'messageId');
    const user = getUser(req), message = db.one<Row>('SELECT * FROM messages WHERE id=? AND deleted_at IS NULL', [messageId]);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    if (message.channel_id ? !canReadChannel(String(message.channel_id), user.id) : !isDmMember(String(message.conversation_id), user.id)) return res.status(403).json({ error: 'You cannot react to this message.' });
    const parsed = z.object({ emoji: z.string().min(1).max(24) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Choose one emoji.' });
    const existing = db.one('SELECT 1 AS yes FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [messageId, user.id, parsed.data.emoji]);
    if (existing) db.run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', [messageId, user.id, parsed.data.emoji]);
    else db.run('INSERT INTO reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)', [messageId, user.id, parsed.data.emoji, nowIso()]);
    const payload = { messageId, reactions: db.query<Row>('SELECT emoji,COUNT(*) AS count,SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS reacted FROM reactions WHERE message_id=? GROUP BY emoji', [user.id, messageId]).map((r) => ({ emoji: String(r.emoji), count: Number(r.count), reacted: Number(r.reacted) > 0 })) };
    io.to(message.channel_id ? `channel:${String(message.channel_id)}` : `dm:${String(message.conversation_id)}`).emit('reaction:updated', payload);
    return res.json(payload);
  });

  const uploadRequestSizes = new WeakMap<Request, number>();
  const storage: multer.StorageEngine = {
    _handleFile(req, file, callback) {
      const filename = crypto.randomUUID();
      const filePath = path.join(uploadDir, filename);
      const requestBytes = uploadRequestSizes.get(req) ?? 0;
      let fileBytes = 0;
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          fileBytes += chunk.length;
          if (fileBytes > uploadLimit || requestBytes + fileBytes > MAX_UPLOAD_REQUEST_BYTES) {
            done(new multer.MulterError('LIMIT_FILE_SIZE'));
            return;
          }
          done(null, chunk);
        }
      });
      void pipeline(file.stream, meter, fs.createWriteStream(filePath, { flags: 'wx' })).then(() => {
        uploadRequestSizes.set(req, requestBytes + fileBytes);
        callback(null, { destination: uploadDir, filename, path: filePath, size: fileBytes });
      }).catch((error: unknown) => {
        fs.rm(filePath, { force: true }, () => callback(error instanceof Error ? error : new Error('Upload failed.')));
      });
    },
    _removeFile(_req, file, callback) {
      if (file.path) fs.rm(file.path, { force: true }, callback);
      else callback(null);
    }
  };
  const upload = multer({ storage, limits: { fileSize: uploadLimit, files: 10, fieldSize: 64 * 1024 } });

  app.post('/api/attachments', auth, (req, res) => {
    req.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
    res.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
    upload.array('files', 10)(req, res, (error) => {
      if (error) {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          const limitLabel = uploadLimit < 1024 * 1024 * 1024
            ? `${Math.floor(uploadLimit / (1024 * 1024))} MB`
            : `${(uploadLimit / (1024 * 1024 * 1024)).toFixed(uploadLimit % (1024 * 1024 * 1024) ? 2 : 0)} GB`;
          return res.status(413).json({ error: `Each file may be up to ${limitLabel}.` });
        }
        for (const file of ((req.files ?? []) as Express.Multer.File[])) fs.rmSync(file.path, { force: true });
        return res.status(400).json({ error: error instanceof Error ? error.message : 'The upload failed.' });
      }
      const user = getUser(req), files = (req.files ?? []) as Express.Multer.File[];
      if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_REQUEST_BYTES) {
        for (const file of files) fs.rmSync(file.path, { force: true });
        return res.status(413).json({ error: 'All files in one upload may not exceed 20 GB combined.' });
      }
      const attachments = files.map((file) => {
        const attachmentId = id();
        const name = safeFilename(file.originalname);
        const contentType = attachmentContentType(name, file.mimetype);
        db.run('INSERT INTO attachments(id,storage_name,original_name,content_type,size,owner_id,created_at) VALUES(?,?,?,?,?,?,?)', [attachmentId, path.basename(file.filename), name, contentType, file.size, user.id, nowIso()]);
        return { id: attachmentId, name, contentType, size: file.size, url: `/api/attachments/${attachmentId}` };
      });
      return res.status(201).json({ attachments });
    });
  });

  const activeChunkUploads = new Set<string>();
  app.post('/api/attachments/chunked', auth, (req, res) => {
    const parsed = z.object({
      name: z.string().min(1).max(1024),
      contentType: z.string().min(1).max(255),
      size: z.number().int().positive().max(uploadLimit)
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid chunked upload details.' });
    const name = safeFilename(parsed.data.name);
    const contentType = attachmentContentType(name, parsed.data.contentType);
    const uploadId = id();
    const storageName = `upload-${crypto.randomUUID()}.part`;
    db.run('INSERT INTO upload_sessions(id,owner_id,original_name,content_type,expected_size,received_size,storage_name,created_at) VALUES(?,?,?,?,?,0,?,?)', [uploadId, getUser(req).id, name, contentType, parsed.data.size, storageName, nowIso()]);
    return res.status(201).json({ uploadId, chunkBytes: UPLOAD_CHUNK_BYTES });
  });

  app.get('/api/attachments/chunked/:uploadId', auth, (req, res) => {
    const upload = db.one<Row>('SELECT expected_size,received_size,completed_attachment_id FROM upload_sessions WHERE id=? AND owner_id=?', [routeParam(req, 'uploadId'), getUser(req).id]);
    if (!upload) return res.status(404).json({ error: 'Upload session not found.' });
    return res.json({ receivedBytes: Number(upload.received_size), totalBytes: Number(upload.expected_size), complete: Boolean(upload.completed_attachment_id) });
  });

  app.put('/api/attachments/chunked/:uploadId', auth, (req, res) => {
    const upload = db.one<Row>('SELECT * FROM upload_sessions WHERE id=? AND owner_id=?', [routeParam(req, 'uploadId'), getUser(req).id]);
    if (!upload) return res.status(404).json({ error: 'Upload session not found.' });
    if (upload.completed_attachment_id) return res.status(409).json({ error: 'This upload is already complete.' });
    const offsetText = req.header('X-Upload-Offset') ?? '';
    if (!/^\d+$/.test(offsetText) || Number(offsetText) !== Number(upload.received_size)) return res.status(409).json({ error: 'Upload chunk offset does not match the server state.' });
    const offset = Number(upload.received_size);
    if (offset >= Number(upload.expected_size)) return res.status(409).json({ error: 'This upload has already received all bytes.' });
    if (activeChunkUploads.has(String(upload.id))) return res.status(409).json({ error: 'Another chunk is currently being written for this upload.' });
    let chunkBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        chunkBytes += chunk.length;
        if (chunkBytes > UPLOAD_CHUNK_BYTES || offset + chunkBytes > Number(upload.expected_size)) {
          done(new Error('Upload chunk exceeds its allowed size.'));
          return;
        }
        done(null, chunk);
      }
    });
    const filePath = path.join(uploadDir, path.basename(String(upload.storage_name)));
    activeChunkUploads.add(String(upload.id));
    req.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
    res.setTimeout(UPLOAD_REQUEST_TIMEOUT_MS);
    void pipeline(req, meter, fs.createWriteStream(filePath, { flags: offset === 0 ? 'wx' : 'a' })).then(() => {
      activeChunkUploads.delete(String(upload.id));
      if (chunkBytes === 0) return res.status(400).json({ error: 'Upload chunk is empty.' });
      const actualSize = fs.statSync(filePath).size;
      if (actualSize !== offset + chunkBytes) return res.status(409).json({ error: 'Upload data is not contiguous.' });
      db.run('UPDATE upload_sessions SET received_size=? WHERE id=? AND owner_id=? AND received_size=?', [actualSize, upload.id, getUser(req).id, offset]);
      const current = db.one<Row>('SELECT received_size FROM upload_sessions WHERE id=? AND owner_id=?', [upload.id, getUser(req).id]);
      if (!current || Number(current.received_size) !== actualSize) return res.status(409).json({ error: 'Upload state changed while writing this chunk.' });
      return res.json({ receivedBytes: actualSize, totalBytes: Number(upload.expected_size) });
    }).catch((error: unknown) => {
      activeChunkUploads.delete(String(upload.id));
      try {
        if (fs.existsSync(filePath)) {
          if (offset === 0) fs.rmSync(filePath, { force: true });
          else fs.truncateSync(filePath, offset);
        }
      } catch { /* Leave the recorded offset unchanged; the next request will safely detect any mismatch. */ }
      if (!res.headersSent) return res.status(400).json({ error: error instanceof Error ? error.message : 'Upload chunk failed.' });
      return undefined;
    });
  });

  app.post('/api/attachments/chunked/:uploadId/complete', auth, (req, res) => {
    const upload = db.one<Row>('SELECT * FROM upload_sessions WHERE id=? AND owner_id=?', [routeParam(req, 'uploadId'), getUser(req).id]);
    if (!upload) return res.status(404).json({ error: 'Upload session not found.' });
    if (upload.completed_attachment_id) {
      const existing = db.one<Row>('SELECT id,original_name,content_type,size FROM attachments WHERE id=? AND owner_id=?', [upload.completed_attachment_id, getUser(req).id]);
      if (!existing) return res.status(404).json({ error: 'Completed attachment not found.' });
      return res.json({ attachment: { id: String(existing.id), name: String(existing.original_name), contentType: String(existing.content_type), size: Number(existing.size), url: `/api/attachments/${String(existing.id)}` } });
    }
    if (Number(upload.received_size) !== Number(upload.expected_size)) return res.status(409).json({ error: 'Upload is incomplete.' });
    const storageName = path.basename(String(upload.storage_name));
    const filePath = path.join(uploadDir, storageName);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== Number(upload.expected_size)) {
      fs.rmSync(filePath, { force: true });
      db.run('DELETE FROM upload_sessions WHERE id=? AND owner_id=?', [upload.id, getUser(req).id]);
      return res.status(400).json({ error: 'The uploaded file is incomplete or unavailable.' });
    }
    const attachmentId = id();
    db.transaction((execute) => {
      execute('INSERT INTO attachments(id,storage_name,original_name,content_type,size,owner_id,created_at) VALUES(?,?,?,?,?,?,?)', [attachmentId, storageName, upload.original_name, upload.content_type, upload.expected_size, getUser(req).id, nowIso()]);
      execute('UPDATE upload_sessions SET completed_attachment_id=? WHERE id=? AND owner_id=? AND completed_attachment_id IS NULL', [attachmentId, upload.id, getUser(req).id]);
    });
    return res.status(201).json({ attachment: { id: attachmentId, name: String(upload.original_name), contentType: String(upload.content_type), size: Number(upload.expected_size), url: `/api/attachments/${attachmentId}` } });
  });

  app.delete('/api/attachments/chunked/:uploadId', auth, (req, res) => {
    const upload = db.one<Row>('SELECT storage_name,completed_attachment_id FROM upload_sessions WHERE id=? AND owner_id=?', [routeParam(req, 'uploadId'), getUser(req).id]);
    if (!upload) return res.json({ ok: true });
    if (upload.completed_attachment_id) return res.status(409).json({ error: 'Completed uploads cannot be cancelled.' });
    if (activeChunkUploads.has(routeParam(req, 'uploadId'))) return res.status(409).json({ error: 'A chunk is still being written; retry cancellation shortly.' });
    fs.rmSync(path.join(uploadDir, path.basename(String(upload.storage_name))), { force: true });
    db.run('DELETE FROM upload_sessions WHERE id=? AND owner_id=?', [routeParam(req, 'uploadId'), getUser(req).id]);
    return res.json({ ok: true });
  });

  app.get('/api/attachments/:attachmentId', auth, (req, res) => {
    const row = db.one<Row>(`SELECT a.* FROM attachments a WHERE a.id=? AND (a.owner_id=? OR EXISTS (SELECT 1 FROM message_attachments ma JOIN messages m ON m.id=ma.message_id JOIN channels c ON c.id=m.channel_id JOIN members mb ON mb.server_id=c.server_id WHERE ma.attachment_id=a.id AND mb.user_id=?))`, [routeParam(req, 'attachmentId'), getUser(req).id, getUser(req).id]);
    if (!row) return res.status(404).json({ error: 'Attachment not found.' });
    const filePath = path.join(uploadDir, path.basename(String(row.storage_name)));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'The attachment file is unavailable.' });
    const size = fs.statSync(filePath).size;
    res.setHeader('Content-Length', size);
    res.type(String(row.content_type));
    res.setHeader('Content-Disposition', `attachment; filename="${String(row.original_name).replace(/["\r\n]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(filePath);
  });

  const gifRateLimit = rateLimit({ windowMs: 60_000, limit: 45, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'GIF search is being used too quickly. Please wait a moment.' } });
  app.get('/api/integrations/tenor/search', auth, gifRateLimit, async (req, res) => {
    const apiKey = options.tenorApiKey ?? process.env.TENOR_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GIF search is not configured on this server. Add TENOR_API_KEY to its private environment.' });
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const query = z.string().max(100).safeParse(rawQuery);
    if (!query.success) return res.status(400).json({ error: 'Search text is too long.' });
    const position = typeof req.query.pos === 'string' && req.query.pos.length <= 120 ? req.query.pos : '';
    try {
      const endpoint = new URL(query.data ? 'https://tenor.googleapis.com/v2/search' : 'https://tenor.googleapis.com/v2/featured');
      endpoint.searchParams.set('key', apiKey);
      endpoint.searchParams.set('client_key', 'orbitchat');
      endpoint.searchParams.set('limit', '24');
      endpoint.searchParams.set('media_filter', 'tinygif,gif');
      if (query.data) endpoint.searchParams.set('q', query.data);
      if (position) endpoint.searchParams.set('pos', position);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) return res.status(502).json({ error: `GIF provider returned HTTP ${response.status}.` });
      const data = await response.json() as { next?: string; results?: Array<{ id: string; title?: string; media_formats?: Record<string, { url: string; dims?: number[] }> }> };
      return res.json({ next: data.next ?? '', results: (data.results ?? []).map((gif) => ({ id: gif.id, title: gif.title ?? 'GIF', url: gif.media_formats?.gif?.url ?? gif.media_formats?.tinygif?.url, previewUrl: gif.media_formats?.tinygif?.url ?? gif.media_formats?.gif?.url, width: gif.media_formats?.gif?.dims?.[0] ?? 0, height: gif.media_formats?.gif?.dims?.[1] ?? 0 })).filter((gif) => gif.url) });
    } catch (error) {
      logger('gif.provider.error', { message: error instanceof Error ? error.message : 'unknown' });
      return res.status(502).json({ error: 'GIF search could not reach the provider. Try again later.' });
    }
  });

  app.post('/api/integrations/tenor/share', auth, gifRateLimit, async (req, res) => {
    const apiKey = options.tenorApiKey ?? process.env.TENOR_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'GIF sharing is not configured on this server.' });
    const parsed = z.object({ gifId: z.string().min(1).max(100), query: z.string().max(100).default('') }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'GIF share details are invalid.' });
    try {
      const endpoint = new URL('https://tenor.googleapis.com/v2/registershare');
      endpoint.searchParams.set('key', apiKey); endpoint.searchParams.set('client_key', 'orbitchat');
      endpoint.searchParams.set('id', parsed.data.gifId); if (parsed.data.query) endpoint.searchParams.set('q', parsed.data.query);
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return res.status(502).json({ error: 'GIF provider could not register this share.' });
      return res.json({ ok: true });
    } catch { return res.status(502).json({ error: 'GIF provider could not register this share.' }); }
  });

  app.get('/api/voice/config', auth, (_req, res) => {
    const iceServers: Array<Record<string, string | string[]>> = [{ urls: 'stun:stun.l.google.com:19302' }];
    const turnUrl = options.turnUrl ?? process.env.TURN_URL;
    const turnUsername = options.turnUsername ?? process.env.TURN_USERNAME;
    const turnCredential = options.turnCredential ?? process.env.TURN_CREDENTIAL;
    if (turnUrl && turnUsername && turnCredential) iceServers.push({ urls: turnUrl.split(',').map((url) => url.trim()), username: turnUsername, credential: turnCredential });
    return res.json({ iceServers, turnConfigured: iceServers.length > 1 });
  });

  app.post('/api/reports', auth, (req, res) => {
    const parsed = z.object({ targetUserId: z.string().uuid().optional(), messageId: z.string().uuid().optional(), reason: z.string().trim().min(5).max(500) }).refine((v) => v.targetUserId || v.messageId).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Select a user or message and describe the concern.' });
    const reporter = getUser(req);
    db.run('INSERT INTO reports(id,reporter_id,target_user_id,message_id,reason,created_at) VALUES(?,?,?,?,?,?)', [id(), reporter.id, parsed.data.targetUserId ?? null, parsed.data.messageId ?? null, parsed.data.reason, nowIso()]);
    return res.status(201).json({ ok: true });
  });

  const activeSockets = new Map<string, number>();
  io.use((socket, next) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    const row = db.one<Row>('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', [tokenHash(token), nowIso()]);
    if (!row) return next(new Error('Sign in to connect.'));
    (socket as LiveSocket).data.user = publicUser(row) as AuthUser;
    return next();
  });
  io.on('connection', (baseSocket) => {
    const socket = baseSocket as LiveSocket, user = socket.data.user!;
    const typingRooms = new Map<string, number>();
    const publishTyping = (room: string, typing: boolean) => {
      if (typing) {
        if (!socket.rooms.has(room)) return;
        const now = Date.now(), last = typingRooms.get(room);
        if (last !== undefined && now - last < 850) return;
        typingRooms.set(room, now);
      } else if (!typingRooms.delete(room)) return;
      socket.to(room).emit('typing:update', { room, userId: user.id, displayName: user.displayName, typing });
    };
    const stopAllTyping = () => { for (const room of [...typingRooms.keys()]) publishTyping(room, false); };
    socket.emit('presence:snapshot', [...activeSockets.keys()]);
    const count = (activeSockets.get(user.id) ?? 0) + 1;
    activeSockets.set(user.id, count);
    socket.join(`user:${user.id}`);
    if (count === 1) io.emit('presence:online', { userId: user.id });
    const leaveOtherContentRooms = (keep: string) => {
      for (const room of socket.rooms) {
        if (room !== socket.id && room !== keep && (room.startsWith('channel:') || room.startsWith('server:') || room.startsWith('dm:'))) {
          if (room.startsWith('channel:') || room.startsWith('dm:')) publishTyping(room, false);
          socket.leave(room);
        }
      }
    };
    socket.on('channel:join', (channelId: unknown, callback?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof channelId !== 'string' || !canReadChannel(channelId, user.id)) return callback?.({ ok: false, error: 'You cannot access this channel.' });
      const channel = db.one<Row>('SELECT server_id FROM channels WHERE id=?', [channelId]);
      leaveOtherContentRooms(`channel:${channelId}`);
      socket.join(`channel:${channelId}`);
      socket.join(`server:${String(channel?.server_id)}`);
      callback?.({ ok: true });
    });
    socket.on('dm:join', (conversationId: unknown, callback?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof conversationId !== 'string' || !isDmMember(conversationId,user.id)) return callback?.({ ok: false, error: 'You cannot access this conversation.' });
      leaveOtherContentRooms(`dm:${conversationId}`);
      socket.join(`dm:${conversationId}`);
      callback?.({ ok: true });
    });
    socket.on('typing:start', () => {
      const room = [...socket.rooms].find((item) => item.startsWith('channel:') || item.startsWith('dm:'));
      if (room) publishTyping(room, true);
    });
    socket.on('typing:stop', stopAllTyping);
    socket.on('voice:join', (channelId: unknown, callback?: (result: { ok: boolean; peers?: string[]; error?: string }) => void) => {
      if (typeof channelId !== 'string' || !canReadChannel(channelId, user.id)) return callback?.({ ok: false, error: 'You cannot join this voice channel.' });
      const channel = db.one<Row>('SELECT server_id,type FROM channels WHERE id=?', [channelId]);
      if (channel?.type !== 'voice') return callback?.({ ok: false, error: 'This is not a voice channel.' });
      for (const room of socket.rooms) {
        if (room.startsWith('voice:') && room !== `voice:${channelId}`) {
          socket.to(room).emit('voice:peer-left', { userId: user.id });
          socket.leave(room);
        }
      }
      const room = `voice:${channelId}`;
      const peers = [...(io.sockets.adapter.rooms.get(room) ?? [])].map((socketId) => (io.sockets.sockets.get(socketId) as LiveSocket | undefined)?.data.user?.id).filter((peer): peer is string => Boolean(peer && peer !== user.id));
      socket.join(room);
      socket.to(room).emit('voice:peer-joined', { userId: user.id });
      callback?.({ ok: true, peers });
    });
    socket.on('voice:signal', async (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const data = payload as { channelId?: unknown; targetUserId?: unknown; description?: unknown; candidate?: unknown };
      if (typeof data.channelId !== 'string' || typeof data.targetUserId !== 'string' || !canReadChannel(data.channelId, user.id) || !canReadChannel(data.channelId, data.targetUserId)) return;
      if (JSON.stringify(payload).length > 64_000) return;
      const targetSockets = await io.in(`user:${data.targetUserId}`).fetchSockets();
      if (!targetSockets.some((targetSocket) => targetSocket.rooms.has(`voice:${data.channelId}`))) return;
      io.to(`user:${data.targetUserId}`).emit('voice:signal', { ...data, userId: user.id });
    });
    socket.on('voice:leave', (channelId: unknown) => {
      if (typeof channelId !== 'string') return;
      if (!socket.rooms.has(`voice:${channelId}`)) return;
      socket.leave(`voice:${channelId}`);
      socket.to(`voice:${channelId}`).emit('voice:peer-left', { userId: user.id });
    });
    socket.on('disconnect', () => {
      const remaining = Math.max(0, (activeSockets.get(user.id) ?? 1) - 1);
      if (remaining === 0) { activeSockets.delete(user.id); io.emit('presence:offline', { userId: user.id }); }
      else activeSockets.set(user.id, remaining);
    });
    socket.on('disconnecting', () => {
      stopAllTyping();
      for (const room of socket.rooms) if (room.startsWith('voice:')) socket.to(room).emit('voice:peer-left', { userId: user.id });
    });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError) return res.status(400).json({ error: 'The request body is invalid.' });
    logger('request.error', { message: error instanceof Error ? error.message : 'unknown' });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? Number(process.env.PORT ?? 0), options.host ?? process.env.HOST ?? '127.0.0.1', () => { httpServer.off('error', reject); resolve(httpServer); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  logger('server.started', { host: options.host ?? process.env.HOST ?? '127.0.0.1', port });
  return {
    app, httpServer, io, db, port,
    close: async () => { await new Promise<void>((resolve) => io.close(() => resolve())); db.close(); }
  };
}

if (require.main === module) {
  createOrbitServer({
    databasePath: path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data_server'), 'orbitchat.sqlite'),
    uploadDir: path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'data_server', 'uploads')),
    host: process.env.HOST ?? '127.0.0.1',
    port: Number(process.env.PORT ?? 8787)
  }).then((server) => printStartupAddresses(server.port)).catch((error) => { console.error('Unable to start OrbitChat server:', error); process.exitCode = 1; });
}

function getLanIpv4Addresses(): string[] {
  const addresses = Object.values(os.networkInterfaces()).flatMap((interfaces) => interfaces ?? [])
    .filter((address) => address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
    .map((address) => address.address);
  return [...new Set(addresses)];
}

function readPlayitEndpoint(): { host: string; port: number } | null {
  const host = process.env.PLAYIT_PUBLIC_HOST?.trim() ?? '';
  const portText = process.env.PLAYIT_PUBLIC_PORT?.trim() ?? '';
  const port = Number(portText);
  const validHostname = host.length <= 253 && /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*\.?$/.test(host);
  if (!validHostname || !/^\d{1,5}$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

async function detectPublicIpv4(): Promise<string | null> {
  try {
    const response = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    const address = (await response.text()).trim();
    return response.ok && net.isIP(address) === 4 ? address : null;
  } catch { return null; }
}

function isPlayitAgentRunning(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try {
        const name = fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim().toLowerCase();
        if (name === 'playit' || name === 'playit-agent') return true;
      } catch { /* Process ended or is not visible; continue the scan. */ }
    }
  } catch { return false; }
  return false;
}

async function canReachPlayitTunnel(endpoint: { host: string; port: number }): Promise<boolean> {
  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/health`, { signal: AbortSignal.timeout(3500), redirect: 'error' });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch { return false; }
}

async function printStartupAddresses(port: number): Promise<void> {
  const lanAddresses = getLanIpv4Addresses();
  const bindHost = process.env.HOST ?? '127.0.0.1';
  const lanUrls = bindHost === '0.0.0.0' || bindHost === '::' || lanAddresses.includes(bindHost)
    ? lanAddresses.map((address) => `http://${address}:${port}`)
    : [];
  const publicIp = await detectPublicIpv4();
  const endpoint = readPlayitEndpoint();
  const agentRunning = isPlayitAgentRunning();
  console.log('OrbitChat API server started over HTTP.');
  console.log(`LAN IP: ${lanAddresses.length ? lanAddresses.join(', ') : 'not detected'}`);
  console.log(`Listener bind host: ${bindHost}`);
  console.log(`LAN API URL: ${lanUrls.length ? lanUrls.join(', ') : 'unavailable (listener is not bound to a LAN interface)'}`);
  console.log(`API port: ${port}`);
  console.log(`Local API URL: http://127.0.0.1:${port}`);
  console.log(`Detected public IP: ${publicIp ?? 'unavailable (lookup failed)'}`);
  console.log(`Playit agent: ${agentRunning ? 'process detected' : 'not detected'}`);
  if (!endpoint) {
    console.log('Playit public hostname/IP and port: not configured');
    console.log('Playit tunnel: not configured');
  } else {
    console.log(`Playit public hostname/IP: ${endpoint.host}`);
    console.log(`Playit public port: ${endpoint.port} (local API port: ${port})`);
    console.log(`Playit tunnel health: ${await canReachPlayitTunnel(endpoint) ? 'verified by HTTP health check' : 'not reachable from this host; check the agent and local port mapping'}`);
  }
  if (lanUrls.length) console.log(`LAN clients use the LAN API URL above; allow inbound TCP ${port} in the host firewall if needed.`);
  else console.log('LAN connections are disabled by the listener bind address.');
}
