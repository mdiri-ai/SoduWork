'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const contract = require('../main/soduwork-app-bridge-contract.cjs');
const { compile, describe, expression } = require('./helpers/app-sdk-compiler.cjs');

function sdk(request) {
  const calls = [], events = {};
  const window = {
    crypto: require('node:crypto').webcrypto,
    addEventListener() {},
    soduWorkAppBridge: {
      async request(method, params) {
        calls.push({ method, params });
        const normalized = contract.normalizeRequest({id: 'sdk-contract', method, params});
        return request(method, normalized.params);
      },
      events: {
        onTurnSettled(callback) { events.settled = callback; },
        onDataChanged(callback) { events.changed = callback; },
      },
    },
  };
  window.parent = window;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'), 'utf8'), {
    window, location: {origin: 'https://app.example'}, document: {referrer: '', querySelectorAll: () => []},
    URL, Uint8Array, setTimeout, clearTimeout,
  });
  return { app: window.soduWorkApp, calls, events };
}

function conforms(receipts) {
  const result = compile(receipts.map(([method, value], i) =>
    `const receipt${i} = ${expression(value)} satisfies SoduWorkApp.Result<${JSON.stringify(method)}>;`).join('\n'));
  assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
}

test('every typed low-level request reaches the real public allowlist with valid method-specific parameters', async () => {
  const upload = 'upload_' + 'a'.repeat(32), file = 'file_' + 'b'.repeat(32);
  const attachment = '11111111-1111-4111-8111-111111111111';
  const inputs = {
    'files.pickLocal': {}, 'files.copyLocal': {projectId: 'p', sourceId: 'source_' + 'c'.repeat(32)},
    'files.begin': {projectId: 'p', name: 'image.png', type: 'image/png', size: 1},
    'files.append': {id: upload, offset: 0, data: [1]}, 'files.finish': {id: upload},
    'files.cancel': {id: upload}, 'files.getUrl': {projectId: 'p', id: file},
    'ai.generate': {input: 'Input', instructions: 'Summarize', requestId: 'ai'},
    'context.get': {}, 'user.getCurrent': {}, 'notifications.list': {},
    'library.list': {storage: 'minio'}, 'library.read': {id: 'material'},
    'conversations.list': {archived: true}, 'conversations.messages': {id: 'chat'},
    'directory.list': {}, 'composer.mention': {requestId: 'mention'},
    'composer.send': {text: 'Send', requestId: 'send'}, 'composer.insertText': {text: 'Draft'},
    'composer.expand': {}, 'composer.collapse': {}, 'settings.get': {}, 'settings.update': {values: {theme: 'dark'}},
    'automation.create': {text: 'Daily report at 09:00', requestId: 'schedule'},
    'data.apps': {}, 'data.get': {collection: 'notes', id: 'note'}, 'data.list': {collection: 'notes', after: null},
    'data.batch': {collection: 'notes', operations: [{id: 'note', value: {}, expectedRevision: 0}]},
    'data.assetPut': {name: 'icon.png', type: 'image/png', data: new Uint8Array([1])},
    'data.assetGet': {id: 'asset_' + 'd'.repeat(64)},
    'mcp.connect': {server: 'service', url: 'https://app.example/mcp', credentialKey: 'credential'},
    'attachments.pick': {}, 'attachments.begin': {name: 'note.txt', type: 'text/plain', size: 1},
    'attachments.append': {id: attachment, offset: 0, data: new Uint8Array([1])},
    'attachments.finish': {id: attachment}, 'attachments.release': {ids: [attachment]}, 'attachments.check': {ids: [attachment]},
  };
  const compiled = compile('declare const requests: SoduWorkApp.RequestMap;\n' + Object.entries(inputs).map(([method, params], i) =>
    `const params${i} = ${expression(params)} satisfies SoduWorkApp.RequestMap[${JSON.stringify(method)}]['params'];`).join('\n'));
  assert.equal(compiled.diagnostics.length, 0, describe(compiled.diagnostics));
  const checker = compiled.program.getTypeChecker();
  const name = compiled.program.getSourceFile(compiled.consumer).statements[0].declarationList.declarations[0].name;
  assert.deepEqual(checker.getTypeAtLocation(name).getProperties().map(row => row.name).sort(), Object.keys(inputs).sort());
  const f = sdk(async () => ({ok: true}));
  for (const [method, params] of Object.entries(inputs)) await f.app.request(method, params);
  assert.deepEqual(f.calls.map(row => row.method).sort(), Object.keys(inputs).sort());
  await assert.rejects(f.app.request('conversation.open', {title: 'Private'}), /未开放/);
  assert.equal(f.calls.length, 37, 'native-only methods must not reach the host');
});

test('actual readonly host replies conform for identity, context, directory, both notification cursors and both library formats', async () => {
  let receive, sequence = 0;
  const pending = new Map();
  const window = {
    btoa, addEventListener() {}, PluginUIHost: {assertUse: async () => {}},
    soduWorkAPI: {workPreviewAppHost: {
      authorize: async () => ({ok: true}),
      onRequest(callback) { receive = callback; },
      respond(id, result) { pending.get(id)(result); pending.delete(id); },
    }},
    SoduWorkAPI: {
      taskStorageKey: () => 'account-a',
      clientAuthMe: async () => ({user: {id: 'user-a', displayName: 'Test user', hidden: 'not public'}}),
      listTeammates: async () => ({mates: [{id: 'user-b', name: 'Colleague', canReceive: true}], orgUnits: []}),
      mateMessages: async () => ({items: [{id: 'notice', text: 'Review', hidden: 'not public'}], nextCursor: 'next'}),
      listLibrary: async () => ({items: [{id: 'file', name: 'note.txt', size: 3}], folders: []}),
      readLibraryContent: async () => ({content: 'Text'}),
      readLibraryBinary: async () => ({blob: new Blob([new Uint8Array([1, 2])], {type: 'application/octet-stream'})}),
    },
    MateNoticeSync: {rows: () => [{id: 'center', serverMessageId: 'notice', text: 'Review', at: 1, read: false}]},
  };
  for (const file of ['app-host-data.js', 'soduwork-app-bridge-host.js']) {
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../components/panels', file), 'utf8'), {window, Uint8Array});
  }
  const f = sdk((method, params) => new Promise(resolve => {
    const id = 'owned-' + ++sequence; pending.set(id, resolve);
    receive({id, appId: 'plugin:local:app', tabId: 'tab', contributionId: 'main', method, params});
  }));
  const receipts = [];
  for (const [method, params] of [
    ['context.get', {}], ['user.getCurrent', {}], ['directory.list', {}],
    ['notifications.list', {}], ['notifications.list', {source: 'center'}],
    ['library.list', {storage: 'nfs'}], ['library.read', {id: 'file'}], ['library.read', {id: 'file', format: 'base64'}],
  ]) receipts.push([method, await f.app.request(method, params)]);
  assert.ok(receipts.every(([, value]) => value.ok));
  assert.doesNotMatch(JSON.stringify(receipts), /hidden|not public/);
  assert.equal(receipts[3][1].nextCursor, 'next');
  assert.equal(receipts[4][1].nextOffset, null);
  conforms(receipts);
});

function nativeStorage(t, {legacy = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sdk-contract-'));
  const app = {getPath: () => root};
  const settings = require('../main/app-settings-store.cjs');
  const data = require('../main/jiyong-data.cjs');
  const attachments = require('../main/work-preview-app-attachments.cjs');
  const files = require('../main/app-files.cjs');
  const binding = {pluginId: 'local:sdk-contract', origin: require('../core/plugin-package-page.cjs').origin('local:sdk-contract')};
  settings.configure({app, ownerOf: () => 'account-a', safeStorage: {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'test_secure',
    encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
  }});
  if (legacy) {
    const scope = settings.scope(binding), folder = path.join(root, 'jiyong-data', scope);
    fs.mkdirSync(folder, {recursive: true});
    const db = new (require('node:sqlite').DatabaseSync)(path.join(folder, 'data.sqlite'));
    try {
      db.exec('CREATE TABLE records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,updatedAt TEXT NOT NULL,PRIMARY KEY(collection,id)); PRAGMA user_version=1;');
      const insert = db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
      insert.run('notes', 'note', JSON.stringify({status: 'open', title: 'Existing'}), 7, '2026-10-01T00:00:00.000Z');
      insert.run('notes', 'old', 'null', 3, '2026-10-01T00:00:00.000Z');
    } finally { db.close(); }
    // Old encrypted rows predate updatedAt/keyRevisions/hosted metadata.
    const row = {values: {theme: 'light', count: 1}, secretKeys: [], revision: 5};
    fs.writeFileSync(path.join(root, 'app-settings.secure.json'), JSON.stringify({schema: 1,
      records: {[scope]: Buffer.from(JSON.stringify(row)).toString('base64')}}));
  }
  const contents = new EventEmitter(); contents.isDestroyed = () => false;
  const owner = {view: {webContents: contents}, appBridge: {appId: 'plugin:' + binding.pluginId, origin: binding.origin}};
  require('../main/work-preview-app-owner.cjs').capture(owner, {app});
  t.after(async () => {
    await data.close(); await attachments.dispose(owner); settings.configure(undefined);
    fs.rmSync(root, {recursive: true, force: true});
  });
  const declaration = {version: 1, parameters: [], collections: [{key: 'notes', indexes: ['status']}]};
  const f = sdk(async (method, params) => {
    if (method.startsWith('attachments.')) return attachments.handle(owner, method, params);
    if (method.startsWith('files.')) return files.execute(app, binding, method, params);
    if (method.startsWith('settings.')) return settings[method === 'settings.get' ? 'get' : 'update'](binding, params);
    return data.execute(app, binding, declaration, method, params);
  });
  return {...f, root, hostApp: app, binding, owner, attachments};
}

test('real attachment staging returns a single item and numeric progress; cancellation releases staged bytes', async t => {
  const f = nativeStorage(t), progress = [];
  const blob = new Blob([new Uint8Array(1024 * 1024 + 3)], {type: 'text/plain'});
  const item = await f.app.attachments.importFile(blob, {onProgress: (loaded, total) => progress.push([loaded, total])});
  assert.equal(item.size, blob.size); assert.equal(item.item, undefined);
  assert.deepEqual(progress, [[1024 * 1024, blob.size], [blob.size, blob.size]]);
  const checked = await f.app.attachments.check([item.id]);
  assert.equal(checked.items[0].id, item.id);
  conforms([['attachments.check', checked], ['attachments.release', await f.app.attachments.release([item.id])]]);
  const controller = new AbortController(), start = f.calls.length;
  await assert.rejects(f.app.attachments.importFile(blob, {signal: controller.signal, onProgress: () => controller.abort()}), /取消/);
  const calls = f.calls.slice(start);
  assert.deepEqual(calls.map(row => row.method), ['attachments.begin', 'attachments.append', 'attachments.release']);
  const missing = await f.app.attachments.check([calls[1].params.id]);
  assert.equal(missing.ok, false); conforms([['attachments.check', missing]]);
});

test('real file persistence returns a complete receipt and object progress; cancellation uses files.cancel', async t => {
  const f = nativeStorage(t), progress = [];
  const blob = new Blob([new Uint8Array(512 * 1024 + 3)], {type: 'image/png'});
  const saved = await f.app.files.importFile(blob, {projectId: 'p', onProgress: value => progress.push(value)});
  assert.equal(saved.ok, true); assert.equal(saved.file.size, blob.size);
  assert.deepEqual(progress.map(row => [row.loaded, row.total]), [[512 * 1024, blob.size], [blob.size, blob.size]]);
  const reopened = await f.app.files.getUrl({projectId: 'p', id: saved.file.id});
  assert.equal(reopened.file.url, saved.file.url);
  const finish = f.calls.find(row => row.method === 'files.finish');
  const repeated = await f.app.request('files.finish', finish.params);
  assert.deepEqual(repeated, saved);
  conforms([['files.finish', saved], ['files.getUrl', reopened], ['files.finish', repeated]]);
  const controller = new AbortController(), start = f.calls.length;
  await assert.rejects(f.app.files.importFile(blob, {projectId: 'p', signal: controller.signal, onProgress: () => controller.abort()}), /取消/);
  assert.deepEqual(f.calls.slice(start).map(row => row.method), ['files.begin', 'files.append', 'files.cancel']);
});

test('existing local records, deletion revisions, null cursors, assets and settings survive the typed SDK path', async t => {
  const f = nativeStorage(t, {legacy: true}), receipts = [];
  const existing = await f.app.data.get({collection: 'notes', id: 'note'});
  assert.equal(existing.revision, 7); assert.equal(existing.item.value.title, 'Existing');
  receipts.push(['data.get', existing]);
  const first = await f.app.data.batch({collection: 'notes', operations: [
    {id: 'note', value: {...existing.item.value, edited: true}, expectedRevision: existing.revision},
  ]});
  assert.equal(first.items[0].revision, 8);
  receipts.push(['data.batch', first]);
  const deleted = await f.app.data.batch({collection: 'notes', operations: [{id: 'old', delete: true, expectedRevision: 3}]});
  assert.equal(deleted.items[0].revision, 4); receipts.push(['data.batch', deleted]);
  for (const after of [undefined, null, '']) {
    const options = {collection: 'notes'}; if (after !== undefined) options.after = after;
    const page = await f.app.data.list(options);
    assert.equal(page.items[0].value.title, 'Existing'); assert.equal(page.items.length, 1);
    receipts.push(['data.list', page]);
  }
  const tombstone = await f.app.data.get({collection: 'notes', id: 'old'});
  assert.equal(tombstone.item, null); assert.equal(tombstone.revision, 4); receipts.push(['data.get', tombstone]);
  const asset = await f.app.data.assetPut({name: 'icon.png', type: 'image/png', data: new Uint8Array([1, 2])});
  const read = await f.app.data.assetGet({id: asset.asset.id});
  assert.deepEqual([...read.data], [1, 2]);
  receipts.push(['data.assetPut', asset], ['data.assetGet', read]);
  const absent = await f.app.data.assetGet({id: 'asset_' + '0'.repeat(64)});
  assert.equal(absent.asset, null); assert.equal(absent.data, undefined); receipts.push(['data.assetGet', absent]);
  const priorSettings = await f.app.settings.get();
  assert.equal(priorSettings.updatedAt, ''); assert.equal(priorSettings.revision, 5);
  const settings = await f.app.settings.update({values: {theme: 'dark'}, expectedRevision: priorSettings.revision});
  const current = await f.app.settings.get();
  assert.equal(current.revision, settings.revision); assert.equal(current.values.theme, 'dark');
  assert.equal(current.revision, 6); assert.equal(current.values.count, 1);
  receipts.push(['settings.get', priorSettings], ['settings.update', settings], ['settings.get', current]);
  conforms(receipts);
});

test('actual one-shot AI success, provider rejection and uncertain replies conform without retrying or starting a conversation', async () => {
  const identity = {hub: 'https://fixture.invalid', clientId: 'device',
    session: require('./helpers/platform-session-fixture.cjs').sessions().renewed};
  const item = {appBridge: {appId: 'local:sdk-ai'}, view: {webContents: new EventEmitter()}};
  let outcome = 'success', posts = 0;
  const generate = require('../main/app-ai-generate.cjs').create({app: {},
    authenticatedIdentityOf: async () => identity, authorizeAI: async () => {},
    resolveModel: async () => ({ok: true, model: {id: 'test-model', baseUrl: 'https://fixture.invalid/v1', key: 'test-ticket', maxOutputTokens: 256}}),
    fetchImpl: async (_url, options) => {
      posts++; const body = JSON.parse(options.body);
      assert.deepEqual(body.messages.map(row => row.role), ['system', 'user']);
      assert.equal(body.tools, undefined);
      if (outcome === 'rejected') return new Response('', {status: 429});
      if (outcome === 'unknown') throw Error('test transport interrupted');
      return Response.json({choices: [{message: {content: 'Verified'}, finish_reason: 'length'}],
        usage: {prompt_tokens: 2, completion_tokens: 3, total_tokens: 5}});
    },
  });
  const f = sdk((_method, params) => generate(item, params));
  const success = await f.app.ai.generate({input: 'Notes', instructions: 'Summarize'});
  assert.equal(success.finishReason, 'length'); assert.equal(success.usage.totalTokens, 5);
  outcome = 'rejected'; const rejected = await f.app.ai.generate({input: 'Notes', instructions: 'Summarize'});
  assert.equal(rejected.ok, false); assert.equal(rejected.httpStatus, 429);
  outcome = 'unknown'; const unknown = await f.app.ai.generate({input: 'Notes', instructions: 'Summarize'});
  assert.equal(unknown.uncertain, true); assert.equal(posts, 3);
  assert.deepEqual(f.calls.map(row => row.method), ['ai.generate', 'ai.generate', 'ai.generate']);
  conforms([['ai.generate', success], ['ai.generate', rejected], ['ai.generate', unknown]]);
});

test('actual automation creation returns saved/waiting and preserves an unknown creation outcome', async () => {
  let fail = false, writes = 0;
  const api = {taskStorageKey: () => 'account-a',
    taskExecutionOptions: async () => ({substrates: [{key: 'local:pi', name: 'Pi', available: true}], repos: []}),
    parseTaskText: async () => ({title: 'Report', note: 'Keep sources'}),
    preflightSchedule: async () => ({state: 'waiting', message: 'Waiting for execution'}),
    createSchedule: async body => { writes++; if (fail) throw Error('test transport interrupted'); return {id: 'schedule', ...body}; },
  };
  const window = {SoduWorkAPI: api, addEventListener() {}, _schmLoad: async () => []};
  const context = vm.createContext({window, SoduWorkAPI: api, Intl, Date, setTimeout, clearTimeout});
  for (const file of ['schedule-timing', 'work-automation-bindings', 'work-automation-card-state', 'work-automation-sheet', 'work-automation-direct']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../components/panels', file + '.js'), 'utf8'), context);
  }
  const f = sdk((_method, params) => window.WorkAutomationDirect.create(params));
  const options = {text: '每天9点整理资料', context: {spaceId: 'space', spaceName: 'Reports'}};
  const created = await f.app.automation.create(options);
  assert.equal(created.state, 'created'); assert.equal(created.executionState, 'waiting'); assert.equal(created.schedule.id, 'schedule');
  fail = true; const unknown = await f.app.automation.create(options);
  assert.equal(unknown.ok, false); assert.equal(unknown.uncertain, true); assert.equal(writes, 2);
  conforms([['automation.create', created], ['automation.create', unknown]]);
});

test('real native and Runner history receipts preserve their distinct formats and cursors', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sdk-history-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const folder = path.join(root, 'pi-agent'); fs.mkdirSync(folder);
  const file = path.join(folder, 'session.jsonl');
  fs.writeFileSync(file, JSON.stringify({type: 'message', id: 'message', message: {role: 'user', content: 'Existing text'}}) + '\n');
  const access = {actor: () => ({owner: 'account-a'}), assertCurrent() {}, assertOwner() {}};
  const session = {
    history: async () => ({ok: true, chats: [{id: 'chat', path: file}]}),
    archivedConversation: async () => ({id: 'chat', adapterId: 'pi'}),
    historyEntry: async () => ({ok: true, entry: {id: 'chat', path: file}}),
  };
  const create = require('../main/app-readonly-history.cjs').create;
  const reader = create({app: {getPath: () => root}, session, access});
  const f = sdk(reader), list = await f.app.conversations.list();
  const messages = await f.app.conversations.messages({id: 'chat'});
  assert.equal(messages.format, 'messages'); assert.equal(messages.items[0].text, 'Existing text');
  const runner = create({app: {getPath: () => root}, session: {archivedConversation: async () => ({id: 'runner', adapterId: 'codex'})}, access,
    runner: {rpc: async () => ({ok: true, data: {seq: 2, items: [{seq: 1, kind: 'text', text: 'Partial', delta: true}]}})}});
  const events = await sdk(runner).app.conversations.messages({id: 'runner'});
  assert.equal(events.format, 'events'); assert.equal(events.nextAfter, 1); assert.equal(events.items[0].delta, true);
  conforms([['conversations.list', list], ['conversations.messages', messages], ['conversations.messages', events]]);
});

test('actual chat admission and review replies remain distinct from execution or notification completion', async t => {
  const f = nativeStorage(t), chat = require('../main/work-preview-app-chat.cjs');
  const contents = new EventEmitter(); contents.isDestroyed = () => false;
  contents.send = (_channel, payload) => queueMicrotask(() => chat.finish(contents, {id: payload.id, ok: true, state: 'review'}));
  f.owner.composer = {view: {webContents: contents}};
  const connected = sdk((method, params) => chat.send(f.owner, params, f.owner, {mention: method === 'composer.mention'}));
  const sent = await connected.app.chat.send({text: 'Process'});
  assert.deepEqual(sent, {ok: true, accepted: true});
  const review = await connected.app.chat.mention({recipientUserId: 'colleague', text: 'Review'});
  assert.deepEqual(review, {ok: true, opened: true, state: 'review'});
  conforms([['composer.send', sent], ['composer.mention', review]]);
});

test('settled and data-change callbacks deliver typed hints, remove subscriptions and discard unrelated payloads', () => {
  const f = sdk(async () => ({ok: true})), received = [], refresh = [];
  const off = f.app.events.onDataChanged(event => received.push(event));
  const offRefresh = f.app.events.onRefresh(event => refresh.push(event));
  f.events.changed({topic: 'library', private: 'not public'});
  f.events.changed({topic: 'content', spaceId: 'space', topicId: 'topic', private: 'not public'});
  f.events.changed({topic: 'unpublished'}); f.events.settled();
  off(); offRefresh(); f.events.changed({topic: 'identity'}); f.events.settled();
  assert.equal(received.length, 2); assert.equal(refresh.length, 1);
  assert.doesNotMatch(JSON.stringify(received), /private|not public/);
  const result = compile(received.map((value, i) => `const event${i} = ${expression(value)} satisfies SoduWorkApp.DataChangedEvent;`).join('\n') +
    `\nconst refresh = ${expression(refresh[0])} satisfies SoduWorkApp.TurnSettledEvent;`);
  assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
});

test('developer packaging supplies usable declarations beside the unchanged SDK while existing apps remain installed', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-sdk-package-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const app = {getPath: () => root}, personal = require('../main/personal-plugins'), resources = require('../main/plugin-resources');
  const old = personal.create(app, {template: 'method', key: 'existing-method', name: 'Existing', description: 'An existing installed method.', version: '1.0.0', instructions: 'Keep the existing behavior.'}).plugin;
  const before = personal.get(app, old.pluginId);
  const developer = personal.get(app, personal.APP_DEVELOPER_ID);
  const bundle = resources.materialize(developer.localDraft.resources, root, developer.key);
  const folder = path.join(bundle.directory, 'references/developer/sdk');
  for (const file of ['soduwork-app.js', 'soduwork-app.d.ts', 'README.md']) {
    assert.deepEqual(fs.readFileSync(path.join(folder, file)), fs.readFileSync(path.resolve(__dirname, '../sdk', file)));
  }
  assert.equal(developer.localDraft.resources.find(row => row.path.endsWith('soduwork-app.d.ts')).kind, 'reference');
  const result = compile(`/// <reference path=${JSON.stringify(path.join(folder, 'soduwork-app.d.ts').replace(/\\/g, '/'))} />\nconst app: SoduWorkApp.SDK = window.soduWorkApp;`, path.join(folder, 'soduwork-app.d.ts'));
  assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
  const after = personal.get(app, old.pluginId);
  assert.equal(after.checksum, before.checksum); assert.equal(after.enabled, before.enabled);
  assert.equal(after.localDraft.instructions, before.localDraft.instructions);
  assert.ok(require('../package.json').build.files.includes('sdk/**/*'));
});
