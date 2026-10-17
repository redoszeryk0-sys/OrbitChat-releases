import { useEffect, useMemo, useState } from 'react';
import { Copy, MoreHorizontal, Reply, SmilePlus, Trash2, Pencil, Flag, Download, ExternalLink, RotateCcw, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { apiRequest, authorizedBlob, formatBytes } from '../lib/api';
import { highlightedMentionSegments } from '../lib/mentions';
import type { Attachment, Message, User } from '../lib/types';
import { OrbitEmojiPicker } from './OrbitEmojiPicker';

interface MessageRowProps {
  message: Message;
  previous?: Message;
  user: User;
  baseUrl: string;
  token: string;
  canModerate: boolean;
  replyTarget?: Message;
  onReply(message: Message): void;
  onEdit(message: Message): void;
  onDelete(message: Message): void;
  onReport(message: Message): void;
  onReact(message: Message, emoji: string): void;
  onOpenImage(url: string, name: string): void;
  onJumpToMessage(id: string): void;
  onToast(text: string): void;
  onRetry?(messageId: string): void;
  onCancel?(messageId: string): void;
}

function useAttachmentUrl(baseUrl: string, token: string, attachment: Attachment): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, objectUrl: string | null = null;
    void authorizedBlob(baseUrl, token, attachment.url).then((result) => { objectUrl = result; if (!disposed) setUrl(result); else URL.revokeObjectURL(result); }).catch(() => setUrl(null));
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [baseUrl, token, attachment.id, attachment.url]);
  return url;
}

function ImageAttachment({ attachment, baseUrl, token, onOpen }: { attachment: Attachment; baseUrl: string; token: string; onOpen(url: string, name: string): void }) {
  const src = useAttachmentUrl(baseUrl, token, attachment);
  return src ? <button className="attachment-image" title={`Open ${attachment.name}`} onClick={() => onOpen(src, attachment.name)}><img src={src} alt={attachment.name} loading="lazy" /></button> : <div className="attachment-loading">Loading image…</div>;
}

function FileAttachment({ attachment, baseUrl, token, onToast }: { attachment: Attachment; baseUrl: string; token: string; onToast(text: string): void }) {
  const download = async () => {
    try { await window.orbit.downloadAttachment(baseUrl, attachment.url, token); }
    catch (error) { onToast(error instanceof Error ? error.message : 'The file could not be downloaded.'); }
  };
  return <button className="file-attachment" onClick={() => void download()} title={`Download ${attachment.name}`}>
    <span className="file-attachment-icon"><Download size={18} /></span><span className="file-attachment-copy"><b>{attachment.name}</b><small>{formatBytes(attachment.size)} · Download</small></span>
  </button>;
}

export function MessageRow(props: MessageRowProps) {
  const { message, previous, user, baseUrl, token } = props;
  const [showEmoji, setShowEmoji] = useState(false), [showMenu, setShowMenu] = useState(false);
  const grouped = !message.deliveryState && previous?.authorId === message.authorId && !previous.deliveryState && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60_000;
  const stamp = useMemo(() => new Date(message.createdAt), [message.createdAt]);
  const canEdit = message.authorId === user.id && !message.deletedAt;
  const canDelete = canEdit || props.canModerate;
  const isUploading = message.deliveryState === 'sending' && message.uploading === true;
  const avatar = (message.authorName || '?').trim().charAt(0).toUpperCase();
  const relative = stamp.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const openLink = (href?: string) => {
    if (href) void window.orbit.openExternal(href);
  };
  const components = {
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} onClick={(event) => { event.preventDefault(); openLink(href); }} title={href}>{children}<ExternalLink size={11} /></a>,
    img: ({ alt }: { alt?: string }) => <span className="markdown-image-blocked">{alt ? `Image link omitted: ${alt}` : 'Use an uploaded attachment to share an image.'}</span>,
    code: ({ children, className }: { children?: React.ReactNode; className?: string }) => className ? <code className={className}>{children}</code> : <code className="inline-code">{children}</code>
  };
  const chooseReaction = (emoji: string) => props.onReact(message, emoji);

  return <article id={`message-${message.id}`} className={`message-row ${grouped ? 'message-grouped' : ''} ${message.deletedAt ? 'message-deleted' : ''} ${message.deliveryState === 'sending' ? 'message-sending' : ''} ${message.deliveryState === 'failed' ? 'message-failed' : ''}`} onContextMenu={(event) => { event.preventDefault(); setShowMenu((value) => !value); }}>
    {!grouped ? <div className="message-avatar" aria-label={message.authorName}>{message.avatarUrl ? <img src={message.avatarUrl} alt="" /> : avatar}</div> : <time className="message-compact-time" title={stamp.toLocaleString()}>{relative}</time>}
    <div className="message-body-wrap">
      {(!grouped || message.deliveryState) && <div className="message-byline"><b>{message.authorName}</b><time title={stamp.toLocaleString()}>{relative}</time>{message.editedAt && <span className="edited-label">edited</span>}{message.deliveryState === 'sending' && <span className="delivery-label">{message.pendingFiles?.length ? `Uploading ${message.uploadProgress ?? 0}%${message.uploadSpeed ? ` · ${message.uploadSpeed}` : ''}` : 'Sending…'}</span>}{message.deliveryState === 'failed' && <span className="delivery-label">Not sent</span>}</div>}
      {message.replyToId && <button className="reply-reference" onClick={() => props.onJumpToMessage(message.replyToId!)}><Reply size={12} /> {props.replyTarget ? `Replying to ${props.replyTarget.authorName}` : 'Replied to a message'}</button>}
      {message.kind === 'gif' && message.mediaUrl && <a className="gif-message" href={message.mediaUrl} onClick={(event) => { event.preventDefault(); openLink(message.mediaUrl!); }}><img src={message.mediaUrl} alt="Animated GIF" loading="lazy" /><span>GIF · Tenor</span></a>}
      {message.kind === 'sticker' && <div className="sticker-message" aria-label="Sticker">{message.stickerEmoji}</div>}
      {message.content && message.kind !== 'sticker' && (message.mentions?.length
        ? <div className="message-content">{highlightedMentionSegments(message.content, message.mentions).map((segment, index) => <span key={`${index}-${segment.text}`} className={segment.mention ? 'message-mention' : undefined}>{segment.text}</span>)}</div>
        : <div className="message-content"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]} components={components}>{message.content}</ReactMarkdown></div>)}
      {message.attachments.length > 0 && <div className="message-attachments">{message.attachments.map((attachment) => attachment.contentType.startsWith('image/')
        ? <ImageAttachment key={attachment.id} attachment={attachment} baseUrl={baseUrl} token={token} onOpen={props.onOpenImage} />
        : <FileAttachment key={attachment.id} attachment={attachment} baseUrl={baseUrl} token={token} onToast={props.onToast} />)}</div>}
      {message.pendingFiles && message.pendingFiles.length > 0 && <div className="message-attachments pending-message-files">{message.pendingFiles.map((file, index) => <div className="file-attachment pending-file-attachment" key={`${file.name}-${index}`}><span className="file-attachment-icon"><Download size={18} /></span><span className="file-attachment-copy"><b>{file.name}</b><small>{formatBytes(file.size)} · {message.deliveryState === 'failed' ? 'Upload failed' : 'Uploading'}</small></span></div>)}</div>}
      {isUploading && <div className="message-upload-progress" role="progressbar" aria-label="File upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={message.uploadProgress ?? 0}><span style={{ width: `${message.uploadProgress ?? 0}%` }} /></div>}
      {message.deliveryState === 'failed' && <button className="message-retry" onClick={() => props.onRetry?.(message.id)}><RotateCcw size={13} /> Retry send</button>}
      {message.reactions.length > 0 && <div className="reaction-list">{message.reactions.map((reaction) => <button key={reaction.emoji} className={`reaction-chip ${reaction.reacted ? 'reacted' : ''}`} onClick={() => props.onReact(message, reaction.emoji)} title="Toggle reaction"><span>{reaction.emoji}</span><b>{reaction.count}</b></button>)}</div>}
      <div className="message-hover-tools" aria-label="Message actions">
        <button title="Add reaction" onClick={() => setShowEmoji((value) => !value)}><SmilePlus size={16} /></button>
        <button title="Reply" onClick={() => props.onReply(message)}><Reply size={16} /></button>
        <button title="Copy text" onClick={() => { void navigator.clipboard.writeText(message.content); props.onToast('Message text copied.'); }}><Copy size={15} /></button>
        <button title="More actions" onClick={() => setShowMenu((value) => !value)}><MoreHorizontal size={17} /></button>
        {showEmoji && <div className="message-emoji-popover" onMouseDown={(event) => event.stopPropagation()}><OrbitEmojiPicker mode="reaction" closeOnPick onPick={chooseReaction} onClose={() => setShowEmoji(false)} /></div>}
      </div>
    </div>
    {showMenu && <>
      <button className="menu-dismiss" aria-label="Close menu" onClick={() => setShowMenu(false)} />
      <div className="message-context-menu" role="menu">
        <button onClick={() => { void navigator.clipboard.writeText(message.content); setShowMenu(false); props.onToast('Message text copied.'); }}><Copy size={15} /> Copy text</button>
        {canEdit && <button onClick={() => { props.onEdit(message); setShowMenu(false); }}><Pencil size={15} /> Edit message</button>}
        {!message.deletedAt && <button onClick={() => { props.onReport(message); setShowMenu(false); }}><Flag size={15} /> Report</button>}
        {isUploading && <button className="danger-menu-item cancel-upload-menu-item" onClick={() => { props.onCancel?.(message.id); setShowMenu(false); }}><X size={15} /> Cancel message</button>}
        {canDelete && !isUploading && <button className="danger-menu-item" onClick={() => { props.onDelete(message); setShowMenu(false); }}><Trash2 size={15} /> Delete message</button>}
      </div>
    </>}
  </article>;
}
