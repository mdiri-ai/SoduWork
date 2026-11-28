'use strict';
// The chat composer passes the runtime handle ref into the branch IPC like
// every other session API; the main-process handler must translate that ref
// into the handle's session id before account sync resolves the source
// conversation, and keep the raw value when no live handle matches.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');

function handler() {
  const start = source.indexOf("  ipcMain.handle('pi-session-conversation-branch'");
  const end = source.indexOf('  // Account-conversation WebSocket messages', start);
  assert.ok(start > 0, 'branch handler must stay in ipc.js');
  let branch = null;
  const main = vm.createContext({
    ipcMain: { handle: (name, fn) => { assert.equal(name, 'pi-session-conversation-branch'); branch = fn; } },
    session: { get: ref => ref === 'chat-runtime' ? { sessionId: 'native' } : null },
    _accountSync: { branch: async (id, options) => ({ id, options }) },
  });
  vm.runInContext(source.slice(start, end), main);
  assert.equal(typeof branch, 'function', 'the branch handler must register on the branch channel');
  return branch;
}

function event(url) {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

test('the branch handler translates the runtime handle ref into the session id', async () => {
  const branch = handler();
  const result = await branch(event('file:///index.html'), 'chat-runtime',
    { instruction: 'Continue', agentId: 'pi' });
  assert.equal(result.id, 'native');
  assert.equal(result.options.instruction, 'Continue');
  assert.equal(result.options.agentId, 'pi');
});

test('the branch handler keeps the raw id when no live handle matches', async () => {
  const branch = handler();
  const result = await branch(event('file:///index.html'), 'archived-session-id', {});
  assert.equal(result.id, 'archived-session-id');
});

test('the branch handler rejects non-workbench senders', async () => {
  const branch = handler();
  const result = await branch(event('https://evil.example/'), 'chat-runtime', {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /工作台/);
});
