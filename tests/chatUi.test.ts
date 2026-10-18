import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarZoom, resolveServerAssetUrl } from '../src/renderer/lib/api';
import { isNearLatest, shouldSendComposerOnEnter, uniqueSelectableAudioDevices } from '../src/renderer/lib/chatUi';

test('Enter sends a message but Shift+Enter and IME composition do not', () => {
  assert.equal(shouldSendComposerOnEnter('Enter', false, false), true);
  assert.equal(shouldSendComposerOnEnter('Enter', true, false), false);
  assert.equal(shouldSendComposerOnEnter('Enter', false, true), false);
  assert.equal(shouldSendComposerOnEnter('Escape', false, false), false);
});

test('latest-scroll detection uses a stable bottom tolerance', () => {
  assert.equal(isNearLatest({ scrollHeight: 1000, scrollTop: 800, clientHeight: 100 }), false);
  assert.equal(isNearLatest({ scrollHeight: 1000, scrollTop: 801, clientHeight: 100 }), true);
  assert.equal(isNearLatest({ scrollHeight: 1000, scrollTop: 0, clientHeight: 100 }), false);
});

test('audio device choices omit the default pseudo-device and duplicate device ids', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - microphone' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset mic' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset mic duplicate' },
    { kind: 'audiooutput', deviceId: 'speaker-1', label: 'USB speakers' },
    { kind: 'videoinput', deviceId: 'camera-1', label: 'Camera' },
    { kind: 'audiooutput', deviceId: '', label: 'Unavailable speaker' },
  ];
  assert.deepEqual(uniqueSelectableAudioDevices(devices), [
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset mic' },
    { kind: 'audiooutput', deviceId: 'speaker-1', label: 'USB speakers' },
  ]);
});

test('server-hosted avatars resolve to the configured API origin', () => {
  assert.equal(resolveServerAssetUrl('https://chat.example', '/api/avatars/avatar-id?zoom=1.5'), 'https://chat.example/api/avatars/avatar-id?zoom=1.5');
  assert.equal(resolveServerAssetUrl('https://chat.example', 'https://cdn.example/avatar.gif'), 'https://cdn.example/avatar.gif');
  assert.equal(resolveServerAssetUrl('https://chat.example', null), undefined);
});

test('avatar zoom is applied consistently and clamped to the editor range', () => {
  assert.equal(avatarZoom('/api/avatars/avatar-id?zoom=1.75'), 1.75);
  assert.equal(avatarZoom('/api/avatars/avatar-id?zoom=9'), 3);
  assert.equal(avatarZoom('/api/avatars/avatar-id?zoom=invalid'), 1);
  assert.equal(avatarZoom(null), 1);
});
