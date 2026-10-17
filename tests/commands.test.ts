import assert from 'node:assert/strict';
import test from 'node:test';
import { unknownSlashCommandMessage } from '../src/renderer/lib/commands';

test('unknown slash commands return the entered command in the response', () => {
  assert.equal(unknownSlashCommandMessage('/unknown'), "Unknown command: /unknown. This command doesn't exist.");
  assert.equal(unknownSlashCommandMessage('  /bad-command extra text  '), "Unknown command: /bad-command. This command doesn't exist.");
});

test('ordinary messages are not treated as commands', () => {
  assert.equal(unknownSlashCommandMessage('hello there'), null);
  assert.equal(unknownSlashCommandMessage(' / '), null);
});
