import type { Member } from './types';

export function mentionQueryAtCaret(value: string, caret: number): { start: number; query: string } | null {
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/[\s([{"']/.test(beforeCaret[at - 1]))) return null;
  const query = beforeCaret.slice(at + 1);
  if (/[\r\n@]/.test(query)) return null;
  return { start: at, query };
}

export function findMentionMatches(query: string, members: Member[], ownUserId?: string, limit = 6): Member[] {
  const normalized = query.trim().toLocaleLowerCase();
  return members
    .filter((member) => member.id !== ownUserId && (
      member.displayName.toLocaleLowerCase().startsWith(normalized) ||
      member.username.toLocaleLowerCase().startsWith(normalized)
    ))
    .slice(0, limit);
}

export function insertMention(value: string, caret: number, start: number, member: Member): { value: string; caret: number } {
  let end = caret;
  while (end < value.length && !/[\s.,!?;:)\]}]/.test(value[end])) end += 1;
  const insertion = `@${member.displayName} `;
  const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  return { value: next, caret: start + insertion.length };
}

export function mentionedMemberIds(content: string, members: Member[], ownUserId?: string): string[] {
  const normalized = content.toLocaleLowerCase().replace(/\s+/g, ' ');
  const matched = new Set<string>();
  const ordered = [...members].filter((member) => member.id !== ownUserId)
    .sort((a, b) => Math.max(b.username.length, b.displayName.length) - Math.max(a.username.length, a.displayName.length));
  for (let at = normalized.indexOf('@'); at >= 0; at = normalized.indexOf('@', at + 1)) {
    if (at > 0 && !/[\s([{"']/.test(normalized[at - 1])) continue;
    for (const member of ordered) {
      const labels = new Set([member.displayName, member.username]);
      for (const label of labels) {
        const escaped = label.trim().toLocaleLowerCase().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
        if (new RegExp(`^${escaped}(?=$|[\\s.,!?;:)\\]}])`, 'u').test(normalized.slice(at + 1))) matched.add(member.id);
      }
    }
  }
  return [...matched];
}

export function highlightedMentionSegments(text: string, mentions: Array<{ username: string; displayName: string }>): Array<{ text: string; mention: boolean }> {
  if (!text || !mentions.length) return [{ text, mention: false }];
  const labels = [...new Set(mentions.flatMap((mention) => [mention.displayName, mention.username]).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!labels.length) return [{ text, mention: false }];
  const expression = new RegExp(`(^|[\\s([{"'])@(${labels.join('|')})(?=$|[\\s.,!?;:)\\]}])`, 'giu');
  const segments: Array<{ text: string; mention: boolean }> = [];
  let offset = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    const leading = match[1] ?? '';
    const full = match[0];
    const atIndex = index + leading.length;
    if (atIndex > offset) segments.push({ text: text.slice(offset, atIndex), mention: false });
    segments.push({ text: full, mention: true });
    offset = index + full.length;
  }
  if (offset < text.length) segments.push({ text: text.slice(offset), mention: false });
  return segments.length ? segments : [{ text, mention: false }];
}