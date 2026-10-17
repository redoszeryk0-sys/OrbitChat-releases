import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { io as createClient, type Socket } from 'socket.io-client';
import { createOrbitServer, type OrbitServer } from '../src/index';
import { Database } from '../src/database';


let root = '';
let server: OrbitServer;
let baseUrl = '';

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbitchat-tests-'));
  server = await createOrbitServer({ databasePath: path.join(root, 'orbitchat.sqlite'), uploadDir: path.join(root, 'uploads'), host: '127.0.0.1', port: 0, logger: () => undefined });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function json<T>(pathName: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${baseUrl}${pathName}`, { ...init, headers });
  return { response, body: await response.json() as T };
}

async function register(username: string) {
  const { response, body } = await json<{ sessionToken: string; user: { id: string; username: string } }>('/api/auth/register', undefined, {
    method: 'POST', body: JSON.stringify({ username, password: 'SecureLocalPassphrase-82', displayName: username })
  });
  assert.equal(response.status, 201);
  return body;
}

async function connectedClient(token: string): Promise<Socket> {
  const socket = createClient(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('socket connection timed out')), 5000);
    socket.once('connect', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timeout); reject(error); });
  });
  return socket;
}

async function acknowledgeJoin(socket: Socket, event: string, roomId: string) {
  const response = await new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit(event, roomId, resolve));
  assert.equal(response.ok, true, response.error);
}

test('health endpoint responds with a truthful server status', async () => {
  const { response, body } = await json<{ ok: boolean; name: string; time: string }>('/health');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.name, 'OrbitChat Server');
  assert.ok(Number.isFinite(Date.parse(body.time)));
});

test('avatars accept JPEG, PNG and GIF, persist history on the API, and restore prior choices', async () => {
  const alice = await register('avatar-alice');
  const bob = await register('avatar-bob');
  const images = [
    { type: 'image/jpeg', bytes: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64') },
    { type: 'image/png', bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZsAAAAASUVORK5CYII=', 'base64') },
    { type: 'image/gif', bytes: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64') }
  ];
  let firstAvatarId = '';
  for (const [index, image] of images.entries()) {
    const form = new FormData();
    form.append('avatar', new Blob([image.bytes], { type: image.type }), `avatar-${index}`);
    form.append('zoom', String(1.25 + index * 0.25));
    const uploaded = await json<{ user: { avatarUrl: string }; avatar: { id: string; contentType: string; zoom: number } }>('/api/me/avatar', alice.sessionToken, { method: 'POST', body: form });
    assert.equal(uploaded.response.status, 200);
    assert.equal(uploaded.body.avatar.contentType, image.type);
    assert.equal(uploaded.body.avatar.zoom, 1.25 + index * 0.25);
    assert.ok(uploaded.body.user.avatarUrl?.includes(uploaded.body.avatar.id));
    if (index === 0) firstAvatarId = uploaded.body.avatar.id;
    const imageResponse = await fetch(`${baseUrl}${uploaded.body.user.avatarUrl}`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), image.type);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), image.bytes);
  }
  const history = await json<{ avatars: Array<{ id: string; contentType: string }> }>('/api/me/avatars', alice.sessionToken);
  assert.equal(history.body.avatars.length, 3);
  const forbiddenHistory = await json('/api/me/avatar/' + firstAvatarId, bob.sessionToken, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(forbiddenHistory.response.status, 404);
  const restored = await json<{ user: { avatarUrl: string | null } }>(`/api/me/avatar/${firstAvatarId}`, alice.sessionToken, { method: 'PATCH', body: JSON.stringify({}) });
  assert.equal(restored.response.status, 200);
  assert.ok(restored.body.user.avatarUrl?.includes(firstAvatarId));
  const invalid = new FormData(); invalid.append('avatar', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  assert.equal((await json('/api/me/avatar', alice.sessionToken, { method: 'POST', body: invalid })).response.status, 400);
  assert.equal((await json('/api/me/avatars', undefined)).response.status, 401);
});

test('database migration adds persisted mention metadata to an existing v1 database', async () => {
  const file = path.join(root, 'legacy-v1.sqlite');
  const legacy = await Database.open(file);
  legacy.run('PRAGMA user_version=1');
  legacy.close();
  const reopened = await Database.open(file);
  assert.ok(reopened.query('PRAGMA table_info(messages)').some((column) => column.name === 'mentions'));
  assert.ok(reopened.query('PRAGMA table_info(avatar_history)').some((column) => column.name === 'content_hash'));
  assert.equal(reopened.one<{ user_version: number }>('PRAGMA user_version')?.user_version, 2);
  reopened.close();
});

test('accounts, server permissions, message persistence, and realtime updates work', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const outsider = await register('outsider');

  const duplicate = await json('/api/auth/register', undefined, { method: 'POST', body: JSON.stringify({ username: 'ALICE', password: 'SecureLocalPassphrase-82' }) });
  assert.equal(duplicate.response.status, 409);
  const invalidLogin = await json('/api/auth/login', undefined, { method: 'POST', body: JSON.stringify({ username: 'alice', password: 'wrong' }) });
  assert.equal(invalidLogin.response.status, 401);
  assert.equal((await json('/api/bootstrap')).response.status, 401);
  assert.equal((await json('/api/bootstrap', alice.sessionToken)).response.status, 200);

  const created = await json<{ server: { id: string; categories: Array<{ id: string; name: string }>; channels: Array<{ id: string; type: string }> }; inviteCode: string }>('/api/servers', alice.sessionToken, { method: 'POST', body: JSON.stringify({ name: 'Test Orbit' }) });
  assert.equal(created.response.status, 201);
  const channel = created.body.server.channels.find((item) => item.type === 'text')!;
  assert.ok(channel);
  assert.equal((await json(`/api/channels/${channel.id}/messages`, bob.sessionToken)).response.status, 403);
  assert.equal((await json(`/api/servers/${created.body.server.id}/channels`, bob.sessionToken, { method: 'POST', body: JSON.stringify({ name: 'blocked' }) })).response.status, 403);
  assert.equal((await json(`/api/servers/${created.body.server.id}/categories`, bob.sessionToken, { method: 'POST', body: JSON.stringify({ name: 'Blocked category' }) })).response.status, 403);

  const newCategory = await json<{ category: { id: string; name: string } }>(`/api/servers/${created.body.server.id}/categories`, alice.sessionToken, { method: 'POST', body: JSON.stringify({ name: 'Game nights' }) });
  assert.equal(newCategory.response.status, 201);
  assert.equal(newCategory.body.category.name, 'Game nights');
  const groupedChannel = await json<{ channel: { categoryId: string | null } }>(`/api/servers/${created.body.server.id}/channels`, alice.sessionToken, { method: 'POST', body: JSON.stringify({ name: 'lobby', type: 'voice', categoryId: newCategory.body.category.id }) });
  assert.equal(groupedChannel.response.status, 201);
  assert.equal(groupedChannel.body.channel.categoryId, newCategory.body.category.id);
  const bootstrap = await json<{ servers: Array<{ categories: Array<{ id: string }> }> }>('/api/bootstrap', alice.sessionToken);
  assert.ok(bootstrap.body.servers[0]?.categories.some((item) => item.id === newCategory.body.category.id));

  const joined = await json(`/api/servers/join`, bob.sessionToken, { method: 'POST', body: JSON.stringify({ inviteCode: created.body.inviteCode }) });
  assert.equal(joined.response.status, 200);
  assert.equal((await json(`/api/channels/${channel.id}/messages`, bob.sessionToken)).response.status, 200);

  const aliceSocket = await connectedClient(alice.sessionToken);
  const bobSocket = await connectedClient(bob.sessionToken);
    let bobMentions = 0;
    let aliceMentions = 0;
    const countBobMention = () => { bobMentions += 1; };
    const countAliceMention = () => { aliceMentions += 1; };
    bobSocket.on('message:mention', countBobMention);
    aliceSocket.on('message:mention', countAliceMention);
  try {
    await acknowledgeJoin(bobSocket, 'channel:join', channel.id);
    const delivered = new Promise<{ id: string; content: string; mentions: Array<{ userId: string; username: string; displayName: string }> }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('realtime message timed out')), 5000);
      bobSocket.once('message:new', (message) => { clearTimeout(timeout); resolve(message); });
    });
    const mentioned = new Promise<{ channelId: string; message: { id: string; mentions: Array<{ userId: string; username: string; displayName: string }> } }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('mention notification timed out')), 5000);
      bobSocket.once('message:mention', (payload) => { clearTimeout(timeout); resolve(payload); });
    });
    const sent = await json<{ message: { id: string; content: string; mentions: Array<{ userId: string; username: string; displayName: string }> } }>(`/api/channels/${channel.id}/messages`, alice.sessionToken, { method: 'POST', body: JSON.stringify({ content: 'Hello @bob and @Alice!', mentions: [bob.user.id] }) });
    assert.equal(sent.response.status, 201);
    assert.equal((await delivered).id, sent.body.message.id);
    assert.ok(sent.body.message.mentions.some((mention) => mention.userId === bob.user.id && mention.username === 'bob'));
    assert.equal((await mentioned).message.id, sent.body.message.id);
      assert.equal(bobMentions, 1);
      assert.equal(aliceMentions, 0);
    assert.equal((await json(`/api/channels/${channel.id}/messages`, bob.sessionToken)).response.status, 200);
    const forgedMention = await json(`/api/channels/${channel.id}/messages`, alice.sessionToken, { method: 'POST', body: JSON.stringify({ content: 'Hello @outsider', mentions: [outsider.user.id] }) });
    assert.equal(forgedMention.response.status, 400);

    const unauthorizedEdit = await json(`/api/messages/${sent.body.message.id}`, bob.sessionToken, { method: 'PATCH', body: JSON.stringify({ content: 'changed by someone else' }) });
    assert.equal(unauthorizedEdit.response.status, 403);
    const editedEvent = new Promise<{ content: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('message edit event timed out')), 5000);
      bobSocket.once('message:updated', (message) => { clearTimeout(timeout); resolve(message); });
    });
    const edited = await json<{ message: { content: string } }>(`/api/messages/${sent.body.message.id}`, alice.sessionToken, { method: 'PATCH', body: JSON.stringify({ content: 'Edited from the account that sent it' }) });
    assert.equal(edited.response.status, 200);
    assert.equal((await editedEvent).content, 'Edited from the account that sent it');

    const reaction = await json<{ reactions: Array<{ emoji: string; count: number }> }>(`/api/messages/${sent.body.message.id}/reactions`, bob.sessionToken, { method: 'POST', body: JSON.stringify({ emoji: '🚀' }) });
    assert.equal(reaction.response.status, 200);
    assert.deepEqual(reaction.body.reactions[0], { emoji: '🚀', count: 1, reacted: true });
  } finally {
    aliceSocket.disconnect(); bobSocket.disconnect();
  }

  await server.close();
  server = await createOrbitServer({ databasePath: path.join(root, 'orbitchat.sqlite'), uploadDir: path.join(root, 'uploads'), host: '127.0.0.1', port: 0, logger: () => undefined });
  baseUrl = `http://127.0.0.1:${server.port}`;
  const history = await json<{ messages: Array<{ content: string }> }>(`/api/channels/${channel.id}/messages`, alice.sessionToken);
  assert.equal(history.response.status, 200);
  assert.equal(history.body.messages[0]?.content, 'Edited from the account that sent it');
  assert.equal((await json('/api/auth/me', alice.sessionToken)).response.status, 200);
});

test('friend requests and direct messages are permission-checked', async () => {
  const june = await register('june');
  const kai = await register('kai');
  const request = await json('/api/friend-requests', june.sessionToken, { method: 'POST', body: JSON.stringify({ username: 'kai' }) });
  assert.equal(request.response.status, 201);
  const pending = await json<{ friends: Array<{ id: string; requestId: string; relation: string }> }>('/api/friends', kai.sessionToken);
  const invitation = pending.body.friends.find((friend) => friend.relation === 'incoming')!;
  assert.ok(invitation?.requestId);

  const accepted = await json<{ conversationId: string }>(`/api/friend-requests/${invitation.requestId}`, kai.sessionToken, { method: 'POST', body: JSON.stringify({ accept: true }) });
  assert.equal(accepted.response.status, 200);
  assert.ok(accepted.body.conversationId);
  const strangers = await register('stranger');
  assert.equal((await json('/api/dms', strangers.sessionToken, { method: 'POST', body: JSON.stringify({ userId: kai.user.id }) })).response.status, 403);

  const juneSocket = await connectedClient(june.sessionToken);
  const kaiSocket = await connectedClient(kai.sessionToken);
  try {
    await acknowledgeJoin(kaiSocket, 'dm:join', accepted.body.conversationId);
    const incoming = new Promise<{ content: string; conversationId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('direct message timed out')), 5000);
      kaiSocket.once('dm:message', (message) => { clearTimeout(timeout); resolve(message); });
    });
    const sent = await json<{ message: { id: string; content: string; attachments: Array<{ id: string; name: string }> } }>(`/api/dms/${accepted.body.conversationId}/messages`, june.sessionToken, { method: 'POST', body: JSON.stringify({ content: 'Hello, friend!' }) });
    assert.equal(sent.response.status, 201);
    assert.equal((await incoming).content, 'Hello, friend!');
    assert.equal((await json(`/api/dms/${accepted.body.conversationId}/messages`, strangers.sessionToken)).response.status, 403);

    const archiveForm = new FormData();
    archiveForm.append('files', new Blob([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])], { type: 'application/java-archive' }), 'dm.jar');
    const uploaded = await fetch(`${baseUrl}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${june.sessionToken}` }, body: archiveForm });
    assert.equal(uploaded.status, 201);
    const uploadedAttachment = (await uploaded.json() as { attachments: Array<{ id: string; name: string }> }).attachments[0]!;
    const dmFile = await json<{ message: { content: string; attachments: Array<{ id: string; name: string }> } }>(`/api/dms/${accepted.body.conversationId}/messages`, june.sessionToken, {
      method: 'POST', body: JSON.stringify({ content: 'Here is the file', attachmentIds: [uploadedAttachment.id] })
    });
    assert.equal(dmFile.response.status, 201);
    assert.equal(dmFile.body.message.attachments[0]?.name, 'dm.jar');
    const dmHistory = await json<{ messages: Array<{ content: string; attachments: Array<{ id: string }> }> }>(`/api/dms/${accepted.body.conversationId}/messages`, kai.sessionToken);
    assert.ok(dmHistory.body.messages.some((message) => message.content === 'Here is the file' && message.attachments[0]?.id === uploadedAttachment.id));
  } finally { juneSocket.disconnect(); kaiSocket.disconnect(); }
});

test('all files including RAR and unknown binary formats upload and download as opaque attachments', async () => {
  const account = await register('anyfilecheck');
  for (const [name, mime] of [['installer.rar', 'application/vnd.rar'], ['file.unknownext', 'application/x-private-format']]) {
    const bytes = new Uint8Array([0x00, 0xff, 0x13, 0x37, 0x42, 0x00, 0x81, 0x22]);
    const form = new FormData();
    form.append('files', new Blob([bytes], { type: mime }), name);
    const upload = await fetch(`${baseUrl}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${account.sessionToken}` }, body: form });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { attachments: Array<{ id: string; name: string; contentType: string; url: string }> };
    assert.equal(uploaded.attachments[0]?.name, name);
    assert.equal(uploaded.attachments[0]?.contentType, 'application/octet-stream');
    const response = await fetch(`${baseUrl}${uploaded.attachments[0]!.url}`, { headers: { Authorization: `Bearer ${account.sessionToken}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
});

test('attachments support verified JAR uploads, authorization and streamed downloads', async () => {
  const account = await register('jarcheck');
  const archive = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  const form = new FormData();
  form.append('files', new Blob([archive], { type: 'application/java-archive' }), 'orbit.jar');
  const upload = await fetch(`${baseUrl}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${account.sessionToken}` }, body: form });
  assert.equal(upload.status, 201);
  const uploaded = await upload.json() as { attachments: Array<{ id: string; size: number; name: string; url: string }> };
  assert.equal(uploaded.attachments[0]?.name, 'orbit.jar');
  assert.equal(uploaded.attachments[0]?.size, archive.length);
  const download = await fetch(`${baseUrl}${uploaded.attachments[0]!.url}`, { headers: { Authorization: `Bearer ${account.sessionToken}` } });
  assert.equal(download.status, 200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()), archive);
});

test('chunked uploads are resumable, authenticated, accept arbitrary files and available as normal attachments', async () => {
  const account = await register('chunkcheck');
  const rar = new Uint8Array([0x00, 0xff, 0x52, 0x41, 0x52, 0x21, 0x1a, 0x07, 0x01, 0x00, 0x41, 0x44]);
  const created = await json<{ uploadId: string; chunkBytes: number }>('/api/attachments/chunked', account.sessionToken, {
    method: 'POST', body: JSON.stringify({ name: 'archive.rar', contentType: 'application/x-rar-compressed', size: rar.length })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.chunkBytes, 1024 * 1024);
  assert.equal((await fetch(`${baseUrl}/api/attachments/chunked/${created.body.uploadId}`, { method: 'PUT', headers: { 'X-Upload-Offset': '0', 'Content-Type': 'application/octet-stream' }, body: rar })).status, 401);
  const first = await fetch(`${baseUrl}/api/attachments/chunked/${created.body.uploadId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${account.sessionToken}`, 'X-Upload-Offset': '0', 'Content-Type': 'application/octet-stream' }, body: rar.subarray(0, 7)
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { receivedBytes: number }).receivedBytes, 7);
  const resumed = await fetch(`${baseUrl}/api/attachments/chunked/${created.body.uploadId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${account.sessionToken}`, 'X-Upload-Offset': '7', 'Content-Type': 'application/octet-stream' }, body: rar.subarray(7)
  });
  assert.equal(resumed.status, 200);
  const completed = await json<{ attachment: { id: string; name: string; size: number; url: string } }>(`/api/attachments/chunked/${created.body.uploadId}/complete`, account.sessionToken, { method: 'POST' });
  assert.equal(completed.response.status, 201);
  assert.equal(completed.body.attachment.name, 'archive.rar');
  assert.equal(completed.body.attachment.contentType, 'application/octet-stream');
  assert.equal(completed.body.attachment.size, rar.length);
  const downloaded = await fetch(`${baseUrl}${completed.body.attachment.url}`, { headers: { Authorization: `Bearer ${account.sessionToken}` } });
  assert.equal(downloaded.status, 200);
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), rar);
  const repeatComplete = await json<{ attachment: { id: string } }>(`/api/attachments/chunked/${created.body.uploadId}/complete`, account.sessionToken, { method: 'POST' });
  assert.equal(repeatComplete.body.attachment.id, completed.body.attachment.id);
});

test('multipart attachment uploads reject a file above the configured limit and clean temporary files', async () => {
  const limited = await createOrbitServer({ databasePath: path.join(root, 'upload-limit.sqlite'), uploadDir: path.join(root, 'limited-uploads'), host: '127.0.0.1', port: 0, maxUploadMb: 1, logger: () => undefined });
  try {
    const limitedUrl = `http://127.0.0.1:${limited.port}`;
    const registered = await fetch(`${limitedUrl}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'limitcheck', password: 'SecureLocalPassphrase-82', displayName: 'limitcheck' }) });
    assert.equal(registered.status, 201);
    const account = await registered.json() as { sessionToken: string };
    const archive = new Uint8Array(1024 * 1024 + 16);
    archive.set([0x50, 0x4b, 0x03, 0x04]);
    const form = new FormData();
    form.append('files', new Blob([archive], { type: 'application/zip' }), 'large.zip');
    const response = await fetch(`${limitedUrl}/api/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${account.sessionToken}` }, body: form });
    assert.equal(response.status, 413);
    assert.match((await response.json() as { error: string }).error, /up to 1 MB/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'limited-uploads')), []);
  } finally { await limited.close(); }
});