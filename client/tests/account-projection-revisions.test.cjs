'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { create } = require('../main/conversation/account-sync');
const { identity } = require('./helpers/platform-session-fixture.cjs');

async function fixture(t, readPage) {
  const conversation = { id: 'account-history', sourceSessionId: 'source-history',
    sourceClientId: 'source-device', title: 'Saved conversation', revision: 1, state: 'idle' };
  const cursors = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      let body;
      if (url.pathname.endsWith('/source')) body = { conversation };
      else if (url.pathname.endsWith('/messages')) {
        const after = Number(url.searchParams.get('after'));
        const limit = Number(url.searchParams.get('limit'));
        cursors.push(after);
        body = { ...await readPage({ after, limit }), conversation };
      } else throw Error('Unexpected fixture route: ' + url.pathname);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const actor = { ...identity(), hub: 'http://127.0.0.1:' + server.address().port };
  const sync = create({ app: {}, identityOf: () => actor, localIdentityOf: () => actor,
    store: { jobs: () => [] }, fetch: (_actor, url, options) => fetch(url, options) });
  t.after(async () => {
    await sync.close();
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  });
  return { sync, cursors };
}

function revisionPages(items, extra = {}) {
  return ({ after, limit }) => {
    const remaining = items.filter(item => item.revision > after);
    const page = remaining.slice(0, limit);
    return { ...extra, items: page, cursor: page.at(-1)?.revision ?? after, hasMore: remaining.length > page.length };
  };
}

test('account projections assemble endpoint deltas across pages and keep the first stream position', async t => {
  const events = [
    { streamId: 'answer', revision: 1, role: 'assistant', text: 'Hello', delta: false },
    { streamId: 'question', revision: 2, role: 'user', text: 'Next question', delta: false },
    ...Array.from({ length: 100 }, (_, index) => ({ streamId: 'answer', revision: index + 3,
      role: 'assistant', text: ' ' + index, delta: true })),
  ];
  const page = revisionPages(events, { format: 'events' });
  const remote = require('../main/pi-session/local-history-remote.cjs').create({ app: {}, session: {},
    identityOf: () => identity(), history: {
      resolve: async () => ({ id: 'source-history', cached: true, count: 2, state: 'idle' }),
      read: async (_id, options) => {
        const result = page(options);
        return { ...result, nextCursor: result.hasMore ? result.cursor : null };
      },
    } });
  const f = await fixture(t, ({ after, limit }) => remote({ action: 'read', id: 'source-history', after, limit }, async () => {}));
  const view = await f.sync.openProjection('account-history');
  const messages = view.snapshot().messages;
  assert.deepEqual(f.cursors, [0, 100]);
  assert.deepEqual(messages.map(item => item.id), ['answer', 'question']);
  assert.equal(messages[0].text, 'Hello' + Array.from({ length: 100 }, (_, index) => ' ' + index).join(''));
  assert.equal(messages[0].blocks[0].text, messages[0].text);
  assert.equal(messages[1].text, 'Next question');
});

test('a later revision replaces a paged message and a tombstone removes the earlier copy', async t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY, position INTEGER, revision INTEGER, text TEXT, deleted INTEGER)');
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,0)');
  for (let index = 0; index < 101; index++) insert.run('message-' + index, index, index + 1, 'Original ' + index);
  const f = await fixture(t, ({ after, limit }) => {
    if (after === 100) {
      db.prepare('UPDATE messages SET revision=102,text=? WHERE id=?').run('Updated answer', 'message-0');
      db.prepare('UPDATE messages SET revision=103,deleted=1 WHERE id=?').run('message-1');
    }
    const rows = db.prepare('SELECT * FROM messages WHERE revision>? ORDER BY revision,id LIMIT ?').all(after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ ...row, role: 'assistant', deleted: !!row.deleted, done: true }));
    return { items, cursor: items.at(-1)?.revision ?? after, hasMore: rows.length > limit };
  });
  const view = await f.sync.openProjection('account-history');
  const messages = view.snapshot().messages;
  assert.deepEqual(f.cursors, [0, 100]);
  assert.equal(messages.length, 100);
  assert.equal(messages.filter(item => item.id === 'message-0').length, 1);
  assert.equal(messages[0].text, 'Updated answer');
  assert.equal(messages.some(item => item.id === 'message-1'), false);
  assert.equal(messages.at(-1).id, 'message-100');
});

test('a full stream update replaces earlier fragments before later deltas append', async t => {
  const f = await fixture(t, revisionPages([
    { id: 'answer', position: 0, revision: 1, role: 'assistant', text: 'Old prefix' },
    { id: 'answer', position: 1, revision: 2, role: 'assistant', text: ' discarded', delta: true },
    { id: 'answer', position: 2, revision: 3, role: 'assistant', text: 'Replacement', delta: false },
    { id: 'answer', position: 3, revision: 4, role: 'assistant', text: ' complete', delta: true, done: true },
  ], { format: 'events' }));
  const view = await f.sync.openProjection('account-history');
  assert.equal(view.snapshot().messages.length, 1);
  assert.equal(view.snapshot().messages[0].text, 'Replacement complete');
  assert.equal(view.snapshot().messages[0].done, true);
});

test('the message limit counts reconstructed messages rather than stream fragments', async t => {
  const f = await fixture(t, revisionPages(Array.from({ length: 1001 }, (_, index) => ({
    id: 'answer', role: 'assistant', position: index, revision: index + 1, text: 'x', delta: true,
  })), { format: 'events' }));
  const view = await f.sync.openProjection('account-history');
  assert.equal(view.snapshot().messages.length, 1);
  assert.equal(view.snapshot().messages[0].text, 'x'.repeat(1001));
});

test('more than 1000 distinct messages still exceed the projection budget', async t => {
  const f = await fixture(t, revisionPages(Array.from({ length: 1001 }, (_, index) => ({
    id: 'message-' + index, role: 'assistant', position: index, revision: index + 1, text: 'x',
  }))));
  await assert.rejects(f.sync.openProjection('account-history'), /读取上限/);
});

test('refresh rebuilds the projection without retaining removed messages or replaying old deltas', async t => {
  let items = [{ id: 'old', position: 1, revision: 1, role: 'assistant', text: 'Old reply', delta: true }];
  const f = await fixture(t, options => revisionPages(items, { format: 'events' })(options));
  const view = await f.sync.openProjection('account-history');
  items = [{ id: 'new', position: 1, revision: 1, role: 'assistant', text: 'New reply', delta: true }];
  assert.equal(await view.refresh(), true);
  assert.equal(await view.refresh(), true);
  assert.deepEqual(view.snapshot().messages.map(item => [item.id, item.text]), [['new', 'New reply']]);
});

test('reconstructed stream text retains the existing per-message bound', async t => {
  const f = await fixture(t, revisionPages([
    { id: 'answer', revision: 1, role: 'assistant', text: 'a'.repeat(150000), delta: true },
    { id: 'answer', revision: 2, role: 'assistant', text: 'b'.repeat(100000), delta: true },
  ], { format: 'events' }));
  const view = await f.sync.openProjection('account-history');
  assert.equal(view.snapshot().messages[0].text, 'a'.repeat(150000) + 'b'.repeat(50000));
});

test('a stalled revision cursor rejects refresh without publishing a partial transcript', async t => {
  let stalled = false;
  const f = await fixture(t, () => ({ format: 'events', cursor: stalled ? 0 : 1, hasMore: stalled,
    items: [{ id: 'answer', revision: 1, role: 'assistant', text: stalled ? 'Incomplete' : 'Complete' }] }));
  const view = await f.sync.openProjection('account-history');
  stalled = true;
  await assert.rejects(view.refresh(), /读取失败/);
  assert.equal(view.snapshot().messages[0].text, 'Complete');
});

test('a stream exceeding the page budget is rejected instead of publishing its partial prefix', async t => {
  const f = await fixture(t, ({ after, limit }) => ({ format: 'events', cursor: after + limit, hasMore: true,
    items: Array.from({ length: limit }, (_, index) => ({ id: 'answer', revision: after + index + 1,
      role: 'assistant', text: 'x', delta: true })) }));
  await assert.rejects(f.sync.openProjection('account-history'), /读取上限/);
  assert.equal(f.cursors.length, 200);
});
