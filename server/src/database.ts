import fs from 'node:fs';
import path from 'node:path';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';

export type Row = Record<string, string | number | Uint8Array | null>;

const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL, username_norm TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL, avatar_url TEXT,
  about TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'online', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
  icon TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', joined_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('text','voice','announcement')),
  topic TEXT NOT NULL DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES dm_conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL, mentions TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'text' CHECK(kind IN ('text','gif','sticker','system')),
  sticker_emoji TEXT, media_url TEXT, reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  edited_at TEXT, deleted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, storage_name TEXT NOT NULL UNIQUE, original_name TEXT NOT NULL,
  content_type TEXT NOT NULL, size INTEGER NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS avatar_history (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_name TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, content_hash TEXT NOT NULL,
  zoom REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(user_id,content_hash)
);
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL, content_type TEXT NOT NULL, expected_size INTEGER NOT NULL,
  received_size INTEGER NOT NULL DEFAULT 0, storage_name TEXT NOT NULL UNIQUE,
  completed_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL REFERENCES attachments(id),
  PRIMARY KEY(message_id,attachment_id)
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY, from_user TEXT NOT NULL REFERENCES users(id), to_user TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
  UNIQUE(from_user,to_user)
);
CREATE TABLE IF NOT EXISTS friendships (
  user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  PRIMARY KEY(user_a,user_b), CHECK(user_a < user_b)
);
CREATE TABLE IF NOT EXISTS dm_conversations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dm_members (
  conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS dm_pairs (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES dm_conversations(id) ON DELETE CASCADE,
  PRIMARY KEY(user_a,user_b), CHECK(user_a < user_b)
);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(user_id,key)
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), target_user_id TEXT REFERENCES users(id),
  message_id TEXT REFERENCES messages(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
  actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL, target_id TEXT, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id,position);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON messages(channel_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient ON friend_requests(to_user,status);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
`;

export class Database {
  private constructor(private readonly db: SqlDatabase, readonly filePath?: string) {}

  static async open(filePath?: string): Promise<Database> {
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    let db: SqlDatabase;
    if (filePath && fs.existsSync(filePath)) db = new SQL.Database(new Uint8Array(fs.readFileSync(filePath)));
    else db = new SQL.Database();
    const result = new Database(db, filePath);
    let versionRow = Number(db.exec('PRAGMA user_version')[0]?.values[0]?.[0] ?? 0);
    if (versionRow < 1) {
      db.run(schema);
      db.run('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)', [new Date().toISOString()]);
      db.run('PRAGMA user_version=1');
      versionRow = 1;
    }
    const messageColumns = db.exec('PRAGMA table_info(messages)')[0]?.values ?? [];
    if (!messageColumns.some((column) => column[1] === 'mentions')) db.run("ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]'");
    if (versionRow < 2) {
      db.run('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)', [new Date().toISOString()]);
      db.run('PRAGMA user_version=2');
    }
    db.run(`CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      original_name TEXT NOT NULL, content_type TEXT NOT NULL, expected_size INTEGER NOT NULL,
      received_size INTEGER NOT NULL DEFAULT 0, storage_name TEXT NOT NULL UNIQUE,
      completed_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL, created_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS avatar_history (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL UNIQUE, content_type TEXT NOT NULL, content_hash TEXT NOT NULL,
      zoom REAL NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE(user_id,content_hash)
    )`);
    result.flush();
    return result;
  }

  query<T extends Row = Row>(sql: string, params: unknown[] = []): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params as (string | number | Uint8Array | null)[]);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally { statement.free(); }
  }

  one<T extends Row = Row>(sql: string, params: unknown[] = []): T | undefined {
    return this.query<T>(sql, params)[0];
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as (string | number | Uint8Array | null)[]);
    this.flush();
  }

  transaction(action: (execute: (sql: string, params?: unknown[]) => void) => void): void {
    this.db.run('BEGIN IMMEDIATE');
    try {
      action((sql, params = []) => this.db.run(sql, params as (string | number | Uint8Array | null)[]));
      this.db.run('COMMIT');
      this.flush();
    }
    catch (error) { this.db.run('ROLLBACK'); throw error; }
  }

  lastInsertId(): number {
    return Number(this.one('SELECT last_insert_rowid() AS id')?.id ?? 0);
  }

  close(): void { this.flush(); this.db.close(); }

  private flush(): void {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, Buffer.from(this.db.export()));
    fs.renameSync(temporaryPath, this.filePath);
  }
}
