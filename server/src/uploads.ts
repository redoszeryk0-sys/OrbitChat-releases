import fs from 'node:fs';
import path from 'node:path';

export const MAX_UPLOAD_MB = 20 * 1024;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_BYTES;
export const UPLOAD_REQUEST_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const DEFAULT_UPLOAD_LIMIT_ENV = '20480';

const safePreviewMimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'
};

export function attachmentContentType(originalName: string, declaredMimeType: string): string {
  const safeImageType = safePreviewMimeTypes[path.extname(originalName).toLowerCase()];
  return safeImageType && declaredMimeType.toLowerCase() === safeImageType ? safeImageType : 'application/octet-stream';
}

export function resolveUploadLimitBytes(value: string | undefined): number {
  if (!value?.trim()) return MAX_UPLOAD_BYTES;
  const megabytes = Number(value);
  if (megabytes === 25 || !Number.isSafeInteger(megabytes) || megabytes < 1) return MAX_UPLOAD_BYTES;
  return Math.min(megabytes, MAX_UPLOAD_MB) * 1024 * 1024;
}

export function normalizeUploadLimitInEnv(env: string): string {
  const lines = env.split(/\r?\n/);
  let found = false;
  const normalized = lines.map((line) => {
    if (!/^MAX_UPLOAD_MB=/.test(line)) return line;
    if (found) return null;
    found = true;
    const raw = line.slice('MAX_UPLOAD_MB='.length).trim();
    const parsed = Number(raw);
    const value = !raw || raw === '25' || !Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_UPLOAD_MB ? MAX_UPLOAD_MB : parsed;
    return `MAX_UPLOAD_MB=${value}`;
  }).filter((line): line is string => line !== null);
  if (!found) normalized.push(`MAX_UPLOAD_MB=${MAX_UPLOAD_MB}`);
  return normalized.join('\n');
}

export function mentionMemberIds(content: string, members: Array<{ id: string; username: string; displayName: string }>): string[] {
  const normalized = content.toLocaleLowerCase().replace(/\s+/g, ' ');
  const mentions = new Set<string>();
  const ordered = [...members].sort((a, b) => Math.max(b.username.length, b.displayName.length) - Math.max(a.username.length, a.displayName.length));
  for (let at = normalized.indexOf('@'); at >= 0; at = normalized.indexOf('@', at + 1)) {
    if (at > 0 && /[\p{L}\p{N}_]/u.test(normalized[at - 1])) continue;
    let longestMatch = 0;
    const matchesAt: string[] = [];
    for (const member of ordered) {
      for (const label of new Set([member.username, member.displayName])) {
        const escaped = label.trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        const match = new RegExp(`^${escaped}(?=$|[\\s.,!?;:)\\]}])`, 'u').exec(normalized.slice(at + 1));
        if (match && match[0].length > longestMatch) { longestMatch = match[0].length; matchesAt.length = 0; }
        if (match && match[0].length === longestMatch) matchesAt.push(member.id);
      }
    }
    for (const userId of matchesAt) mentions.add(userId);
  }
  return [...mentions];
}