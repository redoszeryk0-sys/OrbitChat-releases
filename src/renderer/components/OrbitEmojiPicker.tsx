import { lazy, Suspense } from 'react';
import type { EmojiClickData } from 'emoji-picker-react';
import { Sparkles, X } from 'lucide-react';

const EmojiPicker = lazy(() => import('emoji-picker-react'));

const quickEmojis = [
  { emoji: '😂', name: 'Laughing' },
  { emoji: '❤️', name: 'Love' },
  { emoji: '🔥', name: 'Fire' },
  { emoji: '👀', name: 'Eyes' },
  { emoji: '✨', name: 'Sparkles' },
  { emoji: '🚀', name: 'Rocket' },
  { emoji: '🎉', name: 'Celebrate' },
  { emoji: '😭', name: 'Crying' }
];

export function OrbitEmojiPicker({
  mode,
  onPick,
  onClose,
  closeOnPick = false
}: {
  mode: 'compose' | 'reaction';
  onPick(emoji: string): void;
  onClose(): void;
  closeOnPick?: boolean;
}) {
  const pick = (emoji: string) => {
    onPick(emoji);
    if (closeOnPick) onClose();
  };

  const onEmojiClick = (data: EmojiClickData) => pick(data.emoji);
  const title = mode === 'reaction' ? 'Add a reaction' : 'Emoji orbit';
  const subtitle = mode === 'reaction' ? 'Say it with a little extra feeling' : 'Pick a mood, reaction, or tiny celebration';

  return <section className="orbit-emoji-picker" aria-label={title}>
    <header className="orbit-emoji-heading">
      <span className="orbit-emoji-mark"><Sparkles size={17} /></span>
      <span className="orbit-emoji-heading-copy"><b>{title}</b><small>{subtitle}</small></span>
      <button className="orbit-emoji-close" type="button" title="Close emoji picker" aria-label="Close emoji picker" onClick={onClose}><X size={16} /></button>
    </header>
    <div className="orbit-emoji-quick" role="group" aria-label="Quick emojis">
      {quickEmojis.map(({ emoji, name }) => <button key={name} type="button" title={name} aria-label={mode === 'reaction' ? `React with ${name}` : `Insert ${name} emoji`} onClick={() => pick(emoji)}>{emoji}</button>)}
    </div>
    <Suspense fallback={<div className="orbit-emoji-loading"><Sparkles size={17} /> Loading the galaxy…</div>}>
      <EmojiPicker
        colorScheme="dark"
        className="orbit-emoji-library"
        autoFocusSearch
        onEmojiClick={onEmojiClick}
        width="100%"
        height={326}
        previewConfig={{ defaultEmoji: '🪐', defaultCaption: 'Ready for liftoff?', showPreview: true }}
      />
    </Suspense>
  </section>;
}
