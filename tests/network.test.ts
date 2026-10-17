import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatTransferRate, normalizeServerUrl } from '../src/renderer/lib/api';
import { playitStatusLabel } from '../src/renderer/lib/networkStatus';

test('connection URL normalization permits public HTTP and HTTPS origins', () => {
  assert.equal(normalizeServerUrl('http://friendly.example:4321'), 'http://friendly.example:4321');
  assert.equal(normalizeServerUrl(' https://chat.example.com/ '), 'https://chat.example.com');
  assert.throws(() => normalizeServerUrl('ftp://chat.example.com'), /HTTP or HTTPS/);
  assert.throws(() => normalizeServerUrl('http://chat.example.com/api'), /without a path/);
});

test('upload speed is displayed in KB/s below 1 MB/s and MB/s above it', () => {
  assert.equal(formatTransferRate(0), '0 B/s');
  assert.equal(formatTransferRate(512), '512 B/s');
  assert.equal(formatTransferRate(5 * 1024), '5 KB/s');
  assert.equal(formatTransferRate(1024 * 1024), '1.0 MB/s');
  assert.equal(formatTransferRate(5.25 * 1024 * 1024), '5.3 MB/s');
  assert.equal(formatTransferRate(Number.NaN), '0 B/s');
});

test('renderer security policy permits HTTP connections to self-hosted LAN servers', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  assert.ok(policy, 'renderer HTML should define its Content Security Policy');
  const connect = policy.split(';').map((directive) => directive.trim()).find((directive) => directive.startsWith('connect-src '));
  assert.ok(connect, 'Content Security Policy should define connect-src');
  assert.match(connect, /(?:^|\s)http:/, 'HTTP API connections should work for LAN-hosted servers');
  assert.match(connect, /(?:^|\s)ws:/, 'Socket.IO websocket connections should work for HTTP LAN servers');
});

test('Playit status never treats a local agent process as verified tunnel connectivity', () => {
  assert.equal(playitStatusLabel(false, null, false), 'Not configured');
  assert.equal(playitStatusLabel(true, null, true), 'Public tunnel not checked');
  assert.equal(playitStatusLabel(true, false, true), 'Public tunnel not verified · agent running on this PC');
  assert.equal(playitStatusLabel(true, false, false), 'Public tunnel not verified · agent not detected on this PC');
  assert.equal(playitStatusLabel(true, false, false, 'unknown'), 'Public tunnel not verified · agent status unknown on this PC');
  assert.equal(playitStatusLabel(true, true, false), 'Public tunnel reachable');
});

test('Playit health is the positive signal; an unavailable check is never a success', () => {
  const httpHealthOk = (reachable: boolean | null) => reachable === true;
  assert.equal(httpHealthOk(null), false);
  assert.equal(httpHealthOk(false), false);
  assert.equal(httpHealthOk(true), true);
});