import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentContentType, MAX_UPLOAD_BYTES, MAX_UPLOAD_REQUEST_BYTES, MAX_UPLOAD_MB, mentionMemberIds, normalizeUploadLimitInEnv, resolveUploadLimitBytes } from '../src/uploads';

const members = [
  { id: '1', username: 'aguy', displayName: 'A Guy' },
  { id: '2', username: 'alice', displayName: 'Alice Cooper' },
  { id: '3', username: 'one', displayName: 'Alice' }
];

test('mentions resolve exact usernames and multi-word display names without matching partial names', () => {
  assert.deepEqual(mentionMemberIds('Hi @aguy, please ask @A Guy!', members), ['1']);
  assert.deepEqual(mentionMemberIds('@Alice Cooper and @alice.', members), ['2', '3']);
  assert.deepEqual(mentionMemberIds('@Alice Cooper', members.slice(0, 2)), ['2']);
  assert.deepEqual(mentionMemberIds('email@aguy and @Aguyx and @not-a-member', members), []);
});

test('20 GB upload limit supports legacy custom lower values without exceeding the maximum', () => {
  const twentyGb = 20 * 1024 * 1024 * 1024;
  assert.equal(MAX_UPLOAD_MB, 20 * 1024);
  assert.equal(MAX_UPLOAD_BYTES, twentyGb);
  assert.equal(MAX_UPLOAD_REQUEST_BYTES, twentyGb);
  assert.equal(resolveUploadLimitBytes(undefined), twentyGb);
  assert.equal(resolveUploadLimitBytes('25'), twentyGb);
  assert.equal(resolveUploadLimitBytes('25000'), twentyGb);
  assert.equal(resolveUploadLimitBytes('invalid'), twentyGb);
  assert.match(normalizeUploadLimitInEnv('PORT=8787\nMAX_UPLOAD_MB=25\nHOST=0.0.0.0'), /MAX_UPLOAD_MB=20480/);
  assert.match(normalizeUploadLimitInEnv('PORT=8787\nMAX_UPLOAD_MB=100\nHOST=0.0.0.0'), /MAX_UPLOAD_MB=100/);
  assert.match(normalizeUploadLimitInEnv('PORT=8787\nMAX_UPLOAD_MB=25000'), /MAX_UPLOAD_MB=20480/);
  assert.match(normalizeUploadLimitInEnv('PORT=8787'), /MAX_UPLOAD_MB=20480/);
});

test('arbitrary formats are stored as opaque octet streams while known images retain safe preview types', () => {
  assert.equal(attachmentContentType('installer.rar', 'application/vnd.rar'), 'application/octet-stream');
  assert.equal(attachmentContentType('project.zip', 'application/zip'), 'application/octet-stream');
  assert.equal(attachmentContentType('binary.unknownext', 'application/x-private-format'), 'application/octet-stream');
  assert.equal(attachmentContentType('image.png', 'image/png'), 'image/png');
  assert.equal(attachmentContentType('fake.png', 'text/html'), 'application/octet-stream');
});