import assert from 'node:assert/strict';
import test from 'node:test';
import { findAvailableUpdate } from '../src/electron/main/updateCatalog';

const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/redoszeryk0-sys/OrbitChat-releases/releases/download/1.2.3/${name}`,
});

test('update check selects the highest stable release with a Windows ZIP', () => {
  const update = findAvailableUpdate([
    { tag_name: '1.2.3', prerelease: false, assets: [asset('Orbit-Chat-1.2.3-win-x64.zip')], body: 'Stable patch' },
    { tag_name: '1.9.0-beta.1', prerelease: true, assets: [asset('Orbit-Chat-1.9.0-beta.1-win-x64.zip')] },
    { tag_name: '1.3.0', prerelease: false, assets: [asset('Orbit-Chat-1.3.0-win-x64.zip')] },
  ], '1.2.2.0');

  assert.deepEqual(update, { tag: '1.3.0', version: '1.3.0', notes: '' });
});

test('update check ignores releases without matching ZIPs and releases not newer than installed', () => {
  const releases = [
    { tag_name: '1.2.2', prerelease: false, assets: [asset('Orbit-Chat-1.2.2-win-x64.zip')] },
    { tag_name: '1.2.9', prerelease: false, assets: [asset('Orbit-Chat-Source.zip')] },
  ];

  assert.equal(findAvailableUpdate(releases, '1.2.2.0'), null);
});

test('update check rejects untrusted asset hosts', () => {
  const releases = [{
    tag_name: '1.2.3', prerelease: false,
    assets: [{ name: 'Orbit-Chat-1.2.3-win-x64.zip', browser_download_url: 'https://evil.example/app.zip' }],
  }];

  assert.equal(findAvailableUpdate(releases, '1.2.2'), null);
});

test('update check rejects malformed installed versions', () => {
  const releases = [{ tag_name: '2.0.0', prerelease: false, assets: [asset('Orbit-Chat-2.0.0-win-x64.zip')] }];
  assert.equal(findAvailableUpdate(releases, 'not-a-version'), null);
});
