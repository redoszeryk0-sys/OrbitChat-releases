export interface User {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  about: string;
  status: 'online' | 'idle' | 'dnd' | 'invisible';
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
}

export interface Category {
  id: string;
  serverId: string;
  name: string;
  position: number;
}

export interface Server {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  role: 'owner' | 'admin' | 'member';
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

export interface Reaction { emoji: string; count: number; reacted: boolean }

export interface Message {
  id: string;
  channelId: string;
  conversationId?: string | null;
  authorId: string;
  authorName: string;
  avatarUrl: string | null;
  content: string;
  mentions?: Array<{ userId: string; username: string; displayName: string }>;
  kind: 'text' | 'gif' | 'sticker' | 'system';
  stickerEmoji: string | null;
  mediaUrl: string | null;
  replyToId: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  attachments: Attachment[];
  reactions: Reaction[];
  deliveryState?: 'sending' | 'failed';
  uploading?: boolean;
  uploadProgress?: number;
  uploadSpeed?: string;
  pendingFiles?: Array<{ name: string; size: number }>;
}

export interface Member extends User { role: string }
