type VoiceCue = 'join' | 'leave';

let voiceAudioContext: AudioContext | null = null;

export function primeVoiceSounds(enabled: boolean) {
  if (!enabled || typeof window === 'undefined' || !window.AudioContext) return;
  try {
    voiceAudioContext ??= new window.AudioContext();
    if (voiceAudioContext.state === 'suspended') void voiceAudioContext.resume().catch(() => undefined);
  } catch {
    // Audio feedback is optional; unsupported audio must never block voice chat.
  }
}

export function playVoiceSound(cue: VoiceCue, enabled: boolean) {
  if (!enabled) return;
  primeVoiceSounds(enabled);
  const context = voiceAudioContext;
  if (!context || context.state === 'closed') return;

  const notes = cue === 'join'
    ? [{ frequency: 523.25, start: 0 }, { frequency: 659.25, start: 0.075 }, { frequency: 783.99, start: 0.15 }]
    : [{ frequency: 659.25, start: 0 }, { frequency: 523.25, start: 0.1 }];

  const play = () => {
    const now = context.currentTime + 0.015;
    notes.forEach(({ frequency, start }) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const noteStart = now + start;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.035, noteStart + 0.022);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.19);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.2);
    });
  };

  if (context.state === 'suspended') void context.resume().then(play).catch(() => undefined);
  else play();
}

export function playCosmicVoiceChime(enabled: boolean) {
  if (!enabled) return;
  primeVoiceSounds(enabled);
  const context = voiceAudioContext;
  if (!context || context.state === 'closed') return;
  const play = () => {
    const now = context.currentTime + 0.02;
    [783.99, 987.77, 1174.66].forEach((frequency, index) => {
      const start = now + index * 0.09;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.018, start + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.52);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.54);
    });
  };
  if (context.state === 'suspended') void context.resume().then(play).catch(() => undefined);
  else play();
}
