'use strict';
// The branch handler copies the source conversation's local JSONL archive into
// a new session (only the session header id is rewritten) and returns the new
// session id - no account sync call on this path (#1398).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../main/pi-session/ipc.js'), 'utf8');

function event(url) {
  const frame = { url };
  return { senderFrame: frame, sender: { mainFrame: frame } };
}

function handler() {
  const start = source.indexOf("  ipcMain.handle('pi-session-conversation-branch'");
  const end = source.indexOf('  // Account-conversation WebSocket messages', start);
  assert.ok(start > 0, 'branch handler must stay in ipc.js');
  let branch = null;
  const header = { type: 'session', id: 'native', cwd: 'C:/work' };
  const fsMock = {
    existsSync: () => false,
    readFileSync: () => JSON.stringify(header),
    openSync: () => 1, writeSync: () => {}, writeFileSync: () => {}, closeSync: () => {},
  };
  const sessionMock = {
    get: ref => ref === 'chat-runtime' ? { sessionId: 'native' } : null,
    historyEntry: async (app, id) => ({ ok: true, entry: { path: 'C:/archive/native.jsonl', name: 'origin' } }),
  };
  const main = vm.createContext({
    ipcMain: { handle: (name, fn) => { assert.equal(name, 'pi-session-conversation-branch'); branch = fn; } },
    require: (name) => {
      if (name === 'node:fs' || name === 'fs') return fsMock;
      if (name === 'node:crypto') return require('node:crypto');
      if (name === 'path' || name === 'node:path') return path;
      if (name === './session') return sessionMock;
      if (name === '../conversation/session-memory') return { bind: () => {} };
      throw Error('unexpected require: ' + name);
    },
    session: sessionMock,
    app: {},
    sendIdentityOf: async () => ({ hub: 'https://fixture.invalid', clientId: 'device-a' }),
    identityOf: async () => ({ hub: 'https://fixture.invalid', clientId: 'device-a' }),
  });
  vm.runInContext(source.slice(start, end), main);
  assert.equal(typeof branch, 'function', 'the branch handler must register on the branch channel');
  return branch;
}

test('the branch handler copies the local archive and returns the new session id', async () => {
  const branch = handler();
  const result = await branch(event('file:///index.html'), 'chat-runtime',
    { instruction: 'Continue', agentId: 'pi' });
  assert.equal(result.ok, true);
  assert.equal(result.localCopy, true);
  assert.ok(result.sessionId);
  assert.notEqual(result.sessionId, 'native');
  assert.equal(result.sourceSessionId, 'native');
});

test('the branch handler keeps the raw id when no live handle matches', async () => {
  const branch = handler();
  const result = await branch(event('file:///index.html'), 'archived-session-id', {});
  assert.equal(result.ok, true);
  assert.equal(result.sourceSessionId, 'archived-session-id');
});

test('the branch handler rejects non-workbench senders', async () => {
  const branch = handler();
  const result = await branch(event('https://evil.example/'), 'chat-runtime', {});
  assert.equal(result.ok, false);
  assert.match(result.reason, /工作台/);
});
