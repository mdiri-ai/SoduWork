'use strict';
// Conversation branches POST to the Hub branch route with the account
// conversation id in the JSON body; the path carries only the request id.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sessions = require('../main/pi-session/session');
const { createPiSessionBridge } = require('../main/agent-runtime/pi-session-bridge');
const { create: createSync } = require('../main/conversation/account-sync');
const { create: createStore } = require('../main/conversation/account-sync-store');
const nativeSource = require('../main/conversation/account-native-source.cjs');
const { identity } = require('./helpers/platform-session-fixture.cjs');
const auth = require('../main/device-auth');
const { scope } = require('../main/platform-connections/runtime.cjs');

async function fixture(t, { synced = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-branch-'));
  const app = { getPath: () => root }, actor = identity();
  let current = actor, item = synced ? { id: 'acct-fixture', sourceSessionId: 'native',
    sourceClientId: actor.clientId, title: 'Keep my work', state: 'completed', revision: 1,
    lifecycleRevision: 0, archived: false, deleted: false } : null;
  let stale = false;
  const saved = {};
  for (const key of ['identity', 'session', 'profiles', 'localOwner']) saved[key] = auth[key];
  auth.identity = () => current; auth.session = () => current.session;
  auth.profiles = () => []; auth.localOwner = () => scope(current);
  const file = path.join(root, 'pi-agent', 'sessions', 'workspace', 'native.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'session', id: 'native', cwd: root, timestamp: '2026-11-06T00:00:00Z' },
    { type: 'custom', customType: 'soduwork.work-entry', data: { version: 1, owner: scope(actor) } },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Keep my work' }] } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n');
  require('../main/conversation/session-memory').bind(app, 'native', actor, [], true);
  const branches = [];
  const response = (ok, body, status = ok ? 200 : 503) => ({ ok, status, json: async () => body });
  const fetch = async (_identity, url, options = {}) => {
    if (options.method === 'POST' && url.includes('/account-conversations/branches/')) {
      const body = JSON.parse(options.body); branches.push({ url, body });
      if (stale || !item || body.accountConversationId !== item.id ||
          body.expectedRevision !== item.revision) return response(false, {}, 409);
      return response(true, { ok: true, sessionId: 'branch-session', taskId: 'branch-task' });
    }
    if (url.includes('/source')) return response(Boolean(item), { conversation: item && { ...item } }, item ? 200 : 404);
    return response(true, { items: item ? [{ ...item }] : [], cursor: item?.revision || 0, hasMore: false });
  };
  const bridge = createPiSessionBridge({ app, sessionModule: sessions, runnerAdapters: [] });
  const sync = createSync({ app, identityOf: async () => current,
    store: createStore(path.join(root, 'outbox.json')), fetch,
    resolveNativeSource: (row, id) => nativeSource.resolve({ app, session: bridge, item: row, identity: id }) });
  bridge.setExternalHistory({ history: options => sync.history(options) });
  await sync.history();
  t.after(async () => { await sync.close(); await bridge.dispose(); Object.assign(auth, saved);
    fs.rmSync(root, { recursive: true, force: true }); });
  return { branches, branch: (...args) => sync.branch(...args),
    set stale(value) { stale = value; } };
}

test('branch creation posts to the Hub branch route with the account conversation id in the body', async t => {
  const f = await fixture(t);
  const result = await f.branch('native', { instruction: 'Continue the work', agentId: 'pi' });
  assert.equal(result.ok, true, result.reason);
  assert.equal(f.branches.length, 1);
  const { url, body } = f.branches[0];
  const match = url.match(/\/account-conversations\/branches\/([^/?]+)$/);
  assert.ok(match, 'branch requests must use the Hub branch route: ' + url);
  assert.ok(match[1].length >= 16, 'the path carries the branch request id, not the account id');
  assert.ok(!url.includes('/account-conversations/acct-'), 'the account id never appears in the path');
  assert.equal(body.accountConversationId, 'acct-fixture');
  assert.equal(body.instruction, 'Continue the work');
  assert.equal(body.agentId, 'pi');
  assert.equal(body.expectedRevision, 1);
  assert.equal(result.sessionId, 'branch-session');
  assert.equal(result.taskId, 'branch-task');
});

test('a revision conflict during branch creation reports the change to the caller', async t => {
  const f = await fixture(t);
  f.stale = true;
  const result = await f.branch('native', { instruction: 'Continue the work' });
  assert.equal(result.ok, false);
  assert.equal(result.changed, true);
  assert.equal(f.branches.length, 1, 'the rejected request still reached the Hub branch route');
});

test('an unsynced local conversation branches locally without a hub round trip', async t => {
  const f = await fixture(t, { synced: false });
  const result = await f.branch('native', { instruction: 'Continue the work' });
  // #1398 local-copy fast path: the branch is just a new local session id -
  // no hub request, no cloud branch record.
  assert.equal(result.ok, true);
  assert.equal(result.localCopy, true);
  assert.ok(result.sessionId, result.reason);
  assert.ok(result.taskId, result.reason);
  assert.equal(f.branches.length, 0);
});
