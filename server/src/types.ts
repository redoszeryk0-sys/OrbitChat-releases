export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  about: string;
  status: string;
  createdAt: string;
}

export interface Channel {
  id: string;
  serverId: string;
  categoryId: string | null;
  name: string;
  type: 'text' | 'voice' | 'announcement';
  topic: string;
  position: number;
  unreadCount?: number;
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface ServerSummary {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  role: string;
  categories: Category[];
  channels: Channel[];
}

export interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  url: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  conversationId?: string | null;
  authorId: string;
  authorName: string;
  avatarUrl: string | null;
  content: string;
  mentions: Array<{ userId: string; username: string; displayName: string }>;
  kind: 'text' | 'gif' | 'sticker' | 'system';
  mediaUrl: string | null;
  stickerEmoji: string | null;
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: Attachment[];
  reactions: ReactionSummary[];
}
