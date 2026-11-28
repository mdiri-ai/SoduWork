'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const project = require('../main/conversation/device-history-artifacts.cjs');
const runtime = require('../main/conversation/artifact-runtime');
const native = require('../main/conversation/device-history-native.cjs');
const { setTimeout: delay } = require('node:timers/promises');

function fixture(t, close) {
  const workRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'history-artifacts-')));
  const taskId = 'chat-abcdef-1234', cwd = path.join(workRoot, 'temp', taskId);
  fs.mkdirSync(cwd, { recursive: true });
  t.after(async () => {
    await close?.();
    fs.rmSync(workRoot, { recursive: true, force: true });
  });
  const row = { id: 'runner-native-ref', adapterId: 'opencode', cwd };
  const write = (name, bytes) => {
    const target = path.join(cwd, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return target;
  };
  return { workRoot, row, write, cwd, taskId };
}

function completedWindow(t, files) {
  // Model a session that covered the writes, then replay it after it finished.
  // The filesystem clock and the JavaScript wall clock can tick independently.
  const stamps = files.flatMap(file => {
    const { ctimeNs, mtimeNs } = fs.statSync(file, { bigint: true });
    return [Number(ctimeNs) / 1e6, Number(mtimeNs) / 1e6];
  });
  const started = Math.floor(Math.min(...stamps));
  const ended = Math.ceil(Math.max(...stamps));
  t.mock.timers.enable({ apis: ['Date'], now: ended + 1000 });
  return { started, ended };
}

test('old Runner results recover from an allocated scratch window with no manifest or output events', async t => {
  const f = fixture(t);
  const old = f.write('prior.txt', 'older');
  fs.utimesSync(old, 1, 1);
  const files = [
    f.write('index.html', '<link rel="stylesheet" href="site.css">'),
    f.write('shots/example.png', Buffer.from([137,80,78,71])),
    f.write('site.css', 'body{}'),
    f.write('credentials.json', 'excluded'),
  ];
  fs.symlinkSync(old, path.join(f.cwd, 'linked.txt'));
  fs.linkSync(old, path.join(f.cwd, 'hard.txt'));
  const { started, ended } = completedWindow(t, files);
  const newer = f.write('after-session.txt', 'outside the recorded window');
  fs.utimesSync(newer, new Date(ended + 1000), new Date(ended + 1000));
  const data = await native.read({ app: { getPath: () => f.workRoot }, row: f.row, session: {}, guard() {},
    runtime: { rpc: async () => ({ ok: true, data: { ok: true, seq: 1, ref: f.row.id, taskId: f.taskId, workDir: f.cwd,
      status: 'done', firstStarted: started / 1000, ended: ended / 1000, items: [{ seq: 1, kind: 'say', text: 'complete' }] } }) } });
  assert.equal(data.localWorkspace.cwd, f.cwd);
  const args = { ...f, workspace: data.localWorkspace };
  const indexed = await project.capture(args);
  assert.deepEqual(indexed.items.map(row => row.metadata.relative).sort(), ['index.html', 'shots/example.png']);
  assert.deepEqual(indexed.resources.map(row => row.metadata.relative), ['site.css']);
  assert.equal(indexed.items.find(item => item.metadata.relative === 'index.html').metadata.primary, true);
  assert.equal(await project.capture({ ...args, workspace: { ...data.localWorkspace, taskId: 'different' } }), null);
  assert.equal(await project.capture({ ...args, workspace: { ...data.localWorkspace, id: 'different' } }), null);
  assert.equal(await project.capture({ ...args, workRoot: os.tmpdir() }), null);
  let active = true;
  const session = { historyArtifacts: project.view(f.cwd, indexed, () => { if (!active) throw Error('scope changed'); }) };
  const index = await runtime.snapshotAsync(session), artifact = index.items.find(row => row.kind === 'website');
  const image = index.items.find(row => row.kind === 'image');
  assert.equal(index.delivery.items.length, 1);
  assert.deepEqual(index.got.files, []);
  assert.equal((await runtime.action(session, 'history', image.artifactId, 'image-full', {})).data, 'iVBORw==');
  assert.equal((await runtime.action(session, 'history', artifact.artifactId, 'share-related', {})).ok, false);
  f.write('later.txt', 'unrelated');
  const ref = 'device-history-artifacts-test'; t.after(() => runtime.closeRef(ref));
  const opened = await runtime.preview(session, ref, artifact.artifactId);
  assert.equal(opened.ok, true);
  const get = relative => fetch(new URL(relative, opened.url));
  assert.equal(await (await get('site.css')).text(), 'body{}');
  assert.equal((await get('later.txt')).status, 404);
  assert.equal((await get('linked.txt')).status, 404);
  assert.equal((await get('credentials.json')).status, 404);
  f.write('site.css', 'new stuff');
  f.write('shots/example.png', 'replacement');
  assert.equal((await get('site.css')).status, 404);
  assert.equal((await runtime.action(session, ref, image.artifactId, 'image', {})).ok, false);
  const reloaded = await project.capture({ ...args, previous: indexed });
  assert.equal(project.view(f.cwd, reloaded, () => {}).snapshot().items.some(row => row.kind === 'image'), false);
  active = false;
  assert.equal((await get('index.html')).status, 404);
  await assert.rejects(runtime.snapshotAsync(session), /scope changed/);
});

test('legacy manifests keep preview evidence accessible beside the actual deliveries', async t => {
  const f = fixture(t);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/askAAAAASUVORK5CYII=', 'base64');
  const reserved = '.soduwork/evidence/site.png';
  const files = [reserved, 'diagnostics.png', 'trace.png', 'poster.png'].map(name => f.write(name, png));
  files.push(f.write('index.html', '<title>Page</title>'));
  files.push(f.write('.soduwork/delivery.json', JSON.stringify({
    schemaVersion: 1, processFiles: ['diagnostics.png'], deliverables: [
      { path: 'index.html' }, { path: 'poster.png' }, { path: reserved },
      { path: 'trace.png', primary: true, role: 'verification' }, { path: 'diagnostics.png' },
    ],
  })));
  const history = await project.capture({ ...f, workspace: { id: f.row.id, taskId: f.taskId,
    cwd: f.cwd, ...completedWindow(t, files) } });
  // Old records could mark a capture primary even with the evidence directory or role present.
  for (const row of history.items) {
    if (row.metadata.relative === reserved || row.metadata.relative === 'trace.png') {
      row.metadata.primary = true;
      delete row.metadata.processEvidence;
      if (row.metadata.relative === 'trace.png') row.metadata.role = 'verification';
    }
  }
  const view = project.view(f.cwd, history, () => {});
  const { delivery, items } = view.snapshot();
  assert.deepEqual(delivery.items.map(item => item.relative).sort(), ['index.html', 'poster.png']);
  for (const name of [reserved, 'diagnostics.png', 'trace.png']) {
    const image = items.find(item => item.relative === name);
    assert.equal(image.processEvidence, true);
    assert.equal((await runtime.action({ cwd: f.cwd, historyArtifacts: view }, 'legacy-evidence', image.artifactId, 'image-full', {})).ok, true);
  }
});

test('current-turn receipts distinguish a preview from a replacement illustration and a requested screenshot file', async t => {
  const f = fixture(t), journal = require('../main/conversation/file-change-journal');
  const snapshot = { messages: [], tools: [] };
  let previous;
  async function turn(id, request, answer, filename, content, declared) {
    const before = await journal.snapshot(f.cwd);
    snapshot.startedAt = Date.now() - 10;
    snapshot.messages.push({ role: 'user', text: request }, { role: 'assistant', text: answer, done: true });
    f.write(filename, content);
    if (declared) f.write('.soduwork/delivery.json', JSON.stringify({ schemaVersion: 1, deliverables: [{ path: filename }] }));
    else fs.rmSync(path.join(f.cwd, '.soduwork/delivery.json'), { force: true });
    const changes = journal.compare(before, await journal.snapshot(f.cwd), { turnId: id });
    previous = await project.capture({ row: f.row, previous, snapshot, journal: changes, verifiedTurn: true });
    return previous.items.find(row => row.metadata.relative === filename).metadata;
  }
  snapshot.tools.push({ name: 'browser_screenshot', state: 'done', after: 1, args: { filename: 'cover.png' } });
  const preview = await turn('first', '做个网页并展示截图', '[截图](cover.png)', 'cover.png', 'website capture', true);
  assert.equal(preview.processEvidence, true);
  const cover = await turn('second', '重新设计封面插画', '[封面](cover.png)', 'cover.png', 'new artwork', true);
  assert.equal(cover.processEvidence, false);
  assert.equal(cover.primary, true);
  const requested = await turn('third', '单独交付网页截图文件', '[截图](screenshot.png)', 'screenshot.png', 'requested screenshot');
  assert.equal(requested.processEvidence, false);
  assert.equal(requested.primary, true);
  const linked = await turn('fourth', '制作新版封面', '[封面](cover.png)', 'cover.png', 'linked replacement');
  assert.equal(linked.processEvidence, false);
  assert.equal(linked.primary, true, 'the verified replacement remains a delivery without a fresh manifest');
});

test('old Pi scratch allocations recover shell-generated files only with the original local ref and terminal archive window', async t => {
  const f = fixture(t), id = 'pi-generated', archive = path.join(f.workRoot, 'pi-agent', 'sessions', id + '.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  const { started, ended } = completedWindow(t, [f.write('report.pdf', '%PDF-1.4')]);
  const start = new Date(started).toISOString(), end = new Date(ended).toISOString();
  const entries = [
    { type: 'session', id, cwd: f.cwd, timestamp: start },
    { type: 'message', message: { role: 'user', content: 'make a PDF' }, timestamp: start },
    { type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'completed' }] }, timestamp: end },
  ];
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  const row = { id, ref: f.taskId, cwd: f.cwd, adapterId: 'pi' };
  const app = { getPath: () => f.workRoot }, session = { historyEntry: async () => ({ ok: true, entry: { ...row, path: archive } }) };
  async function recover(candidate) {
    const result = await native.read({ app, row: candidate, session, guard() {} });
    return project.capture({ row: candidate, workRoot: f.workRoot, workspace: result.localWorkspace });
  }
  const saved = await recover(row);
  assert.deepEqual(saved.items.map(item => item.metadata.relative), ['report.pdf']);
  assert.equal(await recover({ ...row, ref: 'different' }), null);
  entries.push({ type: 'message', message: { role: 'user', content: 'continue' } });
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  assert.equal(await recover(row), null);
});

test('Pi compares Windows source roots without crossing another directory, drive or traversal', () => {
  const { sameWorkspace } = require('../main/conversation/pi-history-artifacts.cjs');
  const cwd = 'C:\\Users\\测试\\SoduWork\\temp\\chat-abcdef-1234';
  assert.equal(sameWorkspace(cwd, 'c:/Users/测试/SoduWork/temp/chat-abcdef-1234/', path.win32), true);
  for (const other of [cwd + '-other', cwd.replace('C:', 'D:'), cwd.replace('测试', '别的用户'),
    cwd.replace('Users', 'users'), cwd.replace('Users', 'Other\\..\\Users'), cwd.slice(2)])
    assert.equal(sameWorkspace(cwd, other, path.win32), false);
});

test('Windows resolves actual long and short native root spellings while rejecting a junction or a different directory',
  { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t), { sameWorkspace } = require('../main/conversation/pi-history-artifacts.cjs');
    const alias = path.join(f.workRoot, 'alias');
    fs.symlinkSync(f.cwd, alias, 'junction');
    assert.equal(sameWorkspace(alias, f.cwd), false);
    const alternate = path.join(path.dirname(f.cwd), path.basename(f.cwd).toUpperCase());
    if (fs.existsSync(alternate))
      assert.equal(sameWorkspace(alternate, f.cwd), fs.realpathSync.native(alternate) === fs.realpathSync.native(f.cwd));
    const short = require('node:child_process').execFileSync('cmd.exe',
      ['/d', '/c', 'for %I in (.) do @echo %~sI'], { cwd: f.cwd, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(sameWorkspace(short, f.cwd), true);
    assert.equal(sameWorkspace(path.dirname(short), f.cwd), false);
  });

test('a configured work-root alias retains its allocated scratch; links inside that allocation do not', async t => {
  const f = fixture(t), alias = path.join(f.workRoot, 'configured-alias');
  fs.symlinkSync(f.workRoot, alias, 'junction');
  const { started, ended } = completedWindow(t, [f.write('report.pdf', '%PDF-test')]);
  async function recover(name) {
    const cwd = path.join(alias, 'temp', name), row = { ...f.row, cwd };
    return project.capture({ row, workRoot: alias, workspace: { id: row.id, cwd, taskId: name, started, ended } });
  }
  assert.deepEqual((await recover(f.taskId)).items.map(i => i.metadata.relative), ['report.pdf']);
  const other = 'chat-another-1234';
  fs.symlinkSync(f.cwd, path.join(f.workRoot, 'temp', other), 'junction');
  assert.equal(await recover(other), null);
});

test('completed Pi edit chains attest to the final UTF-8 bytes and originating turn only for deterministic edits', async t => {
  const f = fixture(t), id = 'project-pi';
  const entries = [{ type: 'session', id, cwd: f.cwd }];
  const user = text => ({ type: 'message', message: { role: 'user', content: text } });
  const first = user('write'), second = user('correct the black icon');
  const turns = new Map([[first, { turnId: 'first', userMessageIndex: 0 }], [second, { turnId: 'correction', userMessageIndex: 3 }]]);
  function call(name, args, result) {
    const key = 'call-' + entries.length;
    entries.push({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: key, name, arguments: args }] } },
    { type: 'message', message: { role: 'toolResult', toolName: name, toolCallId: key, isError: false, ...result } });
  }
  entries.push(first);
  const original = '\uFEFF<h1>Huawei</h1>\r\n<svg/>\r\n';
  for (const file of ['huawei.htm', 'ambiguous.htm', 'tampered.htm', 'failed.htm', 'overlap.htm'])
    call('write', { path: path.join(f.cwd, file), content: original });
  entries.push(second);
  const edits = [{ oldText: '<svg/>\n', newText: '<svg fill="white"/>\n' }, { oldText: 'Huawei', newText: '华为' }];
  call('edit', { path: 'huawei.htm', edits });
  call('edit', { path: 'ambiguous.htm', edits: [{ oldText: '<', newText: 'x' }] });
  call('edit', { path: 'tampered.htm', edits });
  call('edit', { path: 'failed.htm', edits }, { isError: true });
  call('edit', { path: 'overlap.htm', edits: [{ oldText: 'Huawei', newText: 'ok' }, { oldText: 'wei', newText: 'bye' }] });
  call('edit', { path: 'unproven.htm', edits });
  entries.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] } });
  f.write('huawei.htm', '\uFEFF<h1>华为</h1>\r\n<svg fill="white"/>\r\n');
  for (const file of ['ambiguous.htm', 'tampered.htm', 'failed.htm', 'overlap.htm', 'unproven.htm']) f.write(file, original);
  const row = { ...f.row, id, adapterId: 'pi', ref: 'now-a-resumed-project' };
  const result = require('../main/conversation/pi-history-artifacts.cjs').evidence(entries, row, 'native-digest', turns);
  assert.equal(result.localWorkspace, undefined);
  const recovered = await project.capture({ row, journal: result.localJournal, nativePiEvidence: true });
  assert.deepEqual(new Map(recovered.items.map(file => [file.metadata.relative, file.source.turnId])),
    new Map([['huawei.htm', 'correction'], ['failed.htm', 'first']]));
});

test('only the final same-turn edit can correct an earlier immutable Pi write receipt', () => {
  const { evidence } = require('../main/conversation/pi-history-artifacts.cjs');
  const cwd = path.resolve('edit-chain'), user = { type: 'message', message: { role: 'user', content: 'create site' } };
  const entries = [{ type: 'session', cwd }, user];
  const turns = new Map([[user, { turnId: 'turn', userMessageIndex: 0 }]]);
  function complete(name, args) {
    const id = 'tool-' + entries.length;
    entries.push({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse',
      content: [{ type: 'toolCall', id, name, arguments: { path: 'logo.htm', ...args } }] } },
    { type: 'message', message: { role: 'toolResult', toolName: name, toolCallId: id, isError: false } });
  }
  const receipt = () => evidence(entries, { id: 'pi', cwd }, 'rev', turns).localJournal.files[0];
  complete('write', { content: 'initial' });
  complete('edit', { edits: [{ oldText: 'initial', newText: 'intermediate' }] });
  assert.equal(receipt().piEditBaseSha256, undefined);
  assert.equal(receipt().piTurn, undefined);
  complete('edit', { edits: [{ oldText: 'intermediate', newText: 'final' }] });
  entries.push({ type: 'message', message: { role: 'assistant', stopReason: 'stop', content: [] } });
  assert.equal(receipt().piEditBaseSha256, crypto.createHash('sha256').update('initial').digest('hex'));
  assert.equal(receipt().after.hash, crypto.createHash('sha256').update('final').digest('hex'));
  assert.equal(receipt().piTurn.turnId, 'turn');
});

test('Pi native edits share a bounded replay budget across different files and do not reuse an unverified base', () => {
  const { evidence } = require('../main/conversation/pi-history-artifacts.cjs');
  const cwd = path.resolve('pi-edit-budget'), row = { id: 'bounded', cwd };
  const entries = [{ type: 'session', id: row.id, cwd }], content = 'prefix' + 'x'.repeat(256 * 1024);
  function complete(name, args) {
    const id = String(entries.length);
    entries.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] } },
      { type: 'message', message: { role: 'toolResult', toolName: name, toolCallId: id, isError: false } });
  }
  for (let n = 0; n < 20; n++) {
    const path = 'bounded-' + n + '.htm';
    complete('write', { path, content });
    complete('edit', { path, edits: [{ oldText: 'prefix', newText: 'replacement' }] });
  }
  complete('write', { path: 'independent.htm', content: 'independent' });
  const { localJournal } = evidence(entries, row, 'native', new Map());
  const matched = localJournal.files.filter(change => change.path.startsWith('bounded-'));
  assert.ok(matched.length > 0 && matched.length < 20);
  assert.ok(matched.every(change => change.after.size === content.length + 5));
  assert.ok(localJournal.files.some(change => change.path === 'independent.htm'));
});

for (const source of ['equivalent native root', 'completed scan cursor', 'first migration with offline originals']) test(
  'legacy Pi reopens edited HTML and scratch XLSX/PNG exactly once: ' + source, async t => {
    const trailingSeparator = source !== 'completed scan cursor', firstMigration = source.startsWith('first');
    let history, store;
    const f = fixture(t, () => history?.close()), id = crypto.randomUUID(), app = { getPath: () => f.workRoot };
    const identity = require('./helpers/platform-session-fixture.cjs').identity();
    const db = path.join(f.workRoot, 'history.sqlite'), file = path.join(f.workRoot, 'pi-agent/sessions', id + '.jsonl');
    const initial = '<html><svg/></html>', html = '<html><svg fill="white"/></html>';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGZsAAAAASUVORK5CYII=', 'base64');
    const sheet = require('../e2e/fixtures/legacy-pi-deliverables.cjs').workbook();
    const names = new Map([['huawei.htm', Buffer.from(html)], ['huawei-preview.png', png], ['销售.xlsx', sheet]]);
    const started = Date.now() - 5000, ended = Date.now() + 1000;
    for (const [name, bytes] of names) {
      const target = f.write(name, bytes), at = (ended + 0.75) / 1000;
      fs.utimesSync(target, at, at);
    }
    const tooLate = f.write('other.xlsx', 'unrelated');
    fs.utimesSync(tooLate, (ended + 1.5) / 1000, (ended + 1.5) / 1000);
    t.mock.timers.enable({ apis: ['Date'], now: ended + 2000 });
    const target = path.join(f.cwd, 'huawei.htm');
    const events = [{ role: 'user', content: 'make a Huawei website and report' }];
    function call(name, args) {
      const key = 'tool-' + events.length;
      events.push({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: key, name, arguments: args }] },
        { role: 'toolResult', toolName: name, toolCallId: key, isError: false, content: [{ type: 'text', text: 'ok' }] });
    }
    call('write', { path: target, content: initial });
    call('bash', { command: 'python generate_report_and_preview.py' });
    call('edit', { path: target, edits: [{ oldText: '<svg/>', newText: '<svg fill="white"/>' }] });
    events.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'huawei.htm、huawei-preview.png、销售.xlsx、other.xlsx' }] });
    const iso = at => new Date(at).toISOString();
    const entries = [{ type: 'session', version: 3, id, cwd: trailingSeparator ? f.cwd + path.sep : f.cwd, timestamp: iso(started) },
      ...events.map((message, i) => ({ type: 'message', id: 'entry-' + i, message, timestamp: iso(i ? ended : started) }))];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = entries.map(e => JSON.stringify(e)).join('\n');
    fs.writeFileSync(file, original);
    const row = { id, cwd: f.cwd, ref: f.taskId, adapterId: 'pi', path: file, count: events.length,
      workOwner: require('../main/platform-connections/runtime.cjs').scope(identity), creator: { account: 'one', hub: identity.hub } };
    const session = { historyEntry: async () => ({ ok: true, entry: row }),
      archivedConversation: async () => null, findBySessionId: () => null };
    function start() {
      store = require('../main/conversation/replica-store.cjs').create(db);
      history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => f.workRoot });
    }
    start();
    const [registered] = await history.register([row]);
    const { snapshot, coverage, localJournal } = await native.read({ app, session, row, guard() {} });
    coverage.sources[0].artifactEvidenceVersion = 2;
    const guard = { expectedRevision: registered.replicaRevision, expectedCatalogRevision: registered.revision, expectedTransferId: '' };
    const prior = trailingSeparator ? {} : { localArtifactHistory: { version: 1, root: f.cwd, items: [], resources: [],
      recordedUntil: ended, packageRecordedUntil: ended, turnId: localJournal.turnId, packageTurnId: localJournal.turnId } };
    if (!firstMigration) await store.saveDeviceHistory(id, { snapshot, coverage, ...prior }, guard);
    assert.ok((await store.saveConversationTranscript(id, snapshot.messages, guard)).ok);
    const dialogue = store.conversationTranscriptDigest(id);
    fs.renameSync(f.cwd, f.cwd + '-offline');
    if (firstMigration) await history.backfill(id);
    else await (await history.open(id, { historyPreview: true })).close();
    assert.equal((await store.deviceHistory(id)).coverage.sources[0].artifactEvidenceVersion, firstMigration ? 0 : 2);
    fs.renameSync(f.cwd + '-offline', f.cwd);
    const view = await history.open(id, { historyPreview: true });
    await view.close();
    const saved = await store.deviceHistory(id);
    assert.deepEqual(saved.snapshot, snapshot);
    assert.equal(store.conversationTranscriptDigest(id), dialogue);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    for (const [name, bytes] of names) assert.deepEqual(fs.readFileSync(path.join(f.cwd, name)), bytes);
    assert.equal(saved.coverage.sources[0].artifactEvidenceVersion, require('../main/conversation/pi-history-artifacts.cjs').VERSION);
    const archive = saved.localArtifactHistory?.archive;
    assert.deepEqual(archive?.versions.filter(v => !v.resource).map(v => v.relative).sort(), [...names.keys()].sort());
    assert.equal(archive.versions.find(v => v.relative === 'huawei.htm').turnId, 'pi-history:' + id + ':entry-0');
    assert.match(archive.versions.find(v => v.relative === '销售.xlsx').turnId, /^pi-archive:[a-f0-9]{64}$/);
    await history.close(); start();
    assert.ok((await store.conversationTranscript(id)).length);
    const capture = t.mock.method(project, 'capture');
    fs.renameSync(f.cwd, f.cwd + '-removed');
    const again = await history.open(id, { historyPreview: true });
    await again.close();
    assert.equal(capture.mock.callCount(), 0, 'ordinary reopen does not repeat file recovery');
    assert.equal((await store.deviceHistory(id)).digest, saved.digest);
    const released = process.env.SODUWORK_STOCK_CLIENT || path.join(__dirname, '..');
    const cold = require(path.join(released, 'main/conversation/artifact-versions.cjs'));
    const groups = await cold.readers(f.workRoot, id, archive, () => {});
    for (const group of groups) for (const item of group.reader.snapshot().items) {
      assert.ok(group.reader.verify(item.path));
      assert.deepEqual(fs.readFileSync(item.path), names.get(item.relative));
    }
    assert.equal(groups.length, 3);
  });

test('first open migrates a legacy Pi write from the native archive and previews its verified bytes', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const id = 'old-pi', archive = path.join(f.workRoot, 'pi-agent', 'sessions', id + '.jsonl');
  const html = '<link rel="stylesheet" href="site.css">', css = 'body{}';
  const entries = [{ type: 'session', id, cwd: f.cwd }, { type: 'message', message: { role: 'user', content: 'make a website' } }];
  const push = message => entries.push({ type: 'message', message });
  function write(target, content, result = {}) {
    const callId = 'call-' + entries.length;
    push({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'write', arguments: { path: target, content } }] });
    push({ role: 'toolResult', toolCallId: callId, toolName: 'write', isError: false, content: [], ...result });
  }
  f.write('index.html', html); write('@index.html', html);
  f.write('site.css', css); write(path.join(f.cwd, 'site.css'), css);
  f.write('changed.md', 'new'); write('changed.md', 'old');
  f.write('failed.md', 'failed'); write('failed.md', 'failed', { isError: true });
  f.write('cancelled.md', 'cancelled'); write('cancelled.md', 'cancelled', { details: { soduWorkAccessChange: { state: 'cancelled' } } });
  const unrelated = f.write('other.md', 'other');
  fs.symlinkSync(unrelated, path.join(f.cwd, 'linked.md')); write('linked.md', 'other');
  write('../' + f.taskId + '/other.md', 'other');
  const published = '会话成果/' + crypto.randomUUID() + '/sibling.md';
  f.write(published, 'sibling'); write(published, 'sibling');
  push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'index.html is ready. other.md' }] });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, entries.map(e => JSON.stringify(e)).join('\n'));
  const row = { id, cwd: f.cwd, adapterId: 'pi', path: archive, count: entries.length - 1,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity), creator: { account: 'one', hub: identity.hub } };
  const session = { historyEntry: async () => ({ ok: true, entry: row }), archivedConversation: async () => null, findBySessionId: () => null };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(f.workRoot, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => f.workRoot });
  const [registered] = await history.register([row]);
  const { snapshot, coverage, localJournal } = await native.read({ app, session, row, guard() {} });
  assert.deepEqual(localJournal.files.find(change => change.path === 'index.html').piTurn,
    { turnId: 'pi-history:old-pi:1', userMessageIndex: 0 });
  delete coverage.sources[0].artifactEvidenceVersion;
  const guard = { expectedRevision: registered.replicaRevision, expectedCatalogRevision: registered.revision };
  await store.saveDeviceHistory(id, { snapshot, coverage }, guard);
  await store.saveConversationTranscript(id, snapshot.messages, guard);
  const view = await history.open(id, { historyPreview: true });
  const index = await runtime.snapshotAsync(view);
  assert.deepEqual(index.items.map(i => i.relative), ['index.html']);
  // The recovered backup still opens after the original directory is gone.
  fs.rmSync(f.cwd, { recursive: true });
  const opened = await runtime.preview(view, view.ref, index.items[0].artifactId);
  try {
    assert.equal(opened.ok, true);
    assert.equal(await (await fetch(opened.url)).text(), html);
    assert.equal(await (await fetch(new URL('site.css', opened.url))).text(), css);
    assert.equal((await fetch(new URL('other.md', opened.url))).status, 404);
  } finally { runtime.closeRef(view.ref); await view.close(); }
});

test('retired Pi writes retain their original turn and bytes beside a newer same-name archive', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const segments = require('../main/conversation/runtime-segments');
  const id = crypto.randomUUID(), next = crypto.randomUUID(), currentRoot = path.join(f.workRoot, 'temp', 'chat-abcdef-9876');
  const nativeDir = path.join(f.workRoot, 'pi-agent', 'sessions');
  fs.mkdirSync(nativeDir, { recursive: true }); fs.mkdirSync(currentRoot);
  function save(id, cwd, messages) {
    const file = path.join(nativeDir, id + '.jsonl');
    const entries = [{ type: 'session', id, cwd }, ...messages.map((message, i) => ({ type: 'message', id: 'm' + i, message }))];
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    return { id, cwd, adapterId: 'pi', path: file };
  }
  const ask = text => ({ role: 'user', content: text });
  const reply = text => ({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] });
  function write(callId, file, content) {
    return [{ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'write', arguments: { path: file, content } }] },
      { role: 'toolResult', toolCallId: callId, toolName: 'write', isError: false, content: [] }];
  }
  f.write('index.html', 'original'); f.write('notes.md', 'first');
  fs.writeFileSync(path.join(currentRoot, 'index.html'), 'latest');
  const old = save(id, f.cwd, [ask('create notes'), ...write('call', 'notes.md', 'first'), reply('done'),
    { ...ask('make a website'), submissionId: 'old-website' }, ...write('call', 'index.html', 'original'), reply('done')]);
  const active = save(next, currentRoot, [ask('continue'), reply('latest')]);
  let reads = 0, restriction;
  const session = { historyEntry: async (_, wanted) => {
    if (wanted === id) reads++;
    const row = wanted === id ? old : active;
    return fs.existsSync(row.path) ? { ok: true, entry: { ...row, ...(wanted === id ? restriction : {}) } } : { ok: false, notFound: true };
  }, findBySessionId: () => null };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(f.workRoot, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => f.workRoot });
  const { snapshot, localJournal } = await native.read({ app, session, row: old, guard() {} });
  const websiteIndex = snapshot.messages.findIndex(m => m.submissionId === 'old-website');
  assert.ok(websiteIndex > 1);
  assert.deepEqual(localJournal.files.map(change => change.piTurn),
    [{ turnId: 'pi-history:' + id + ':m0', userMessageIndex: 0 }, { turnId: 'old-website', userMessageIndex: websiteIndex }]);
  const record = { version: 1, id, originAdapter: 'pi', segments: [], prefix: snapshot, deviceHistoryComplete: true,
    active: { sessionId: next, adapterId: 'pi', ref: path.basename(currentRoot) }, cwd: currentRoot, owner: segments.scope(identity) };
  await segments.save(app, record);
  const row = { ...old, cwd: currentRoot, ref: path.basename(currentRoot), workOwner: record.owner, creator: { account: 'one', hub: identity.hub } };
  const [registered] = await history.register([row]);
  const body = await native.read({ app, session, row, guard() {} });
  const journal = { cwd: currentRoot, turnId: 'new-website', userMessageIndex: snapshot.messages.length, files: [
    { action: 'created', path: 'index.html', after: { path: 'index.html', exists: true, size: 6,
      hash: crypto.createHash('sha256').update('latest').digest('hex') } }] };
  const archive = require('../main/conversation/device-artifact-archive.cjs');
  const collected = await project.capture({ row, journal, verifiedTurn: true });
  const prior = await archive.preserve(f.workRoot, id, collected, null, () => {});
  await store.saveDeviceHistory(id, { ...body, localArtifactHistory: prior, localPiOriginReviewed: id }, { expectedRevision: registered.replicaRevision });
  fs.renameSync(old.path, old.path + '.gone');
  const missing = await history.prepareContinuation(id, { refresh: true });
  assert.equal(missing.artifactHistory.archive.generation, prior.archive.generation);
  fs.renameSync(old.path + '.gone', old.path);
  restriction = { historyProtection: 'account' };
  await assert.rejects(native.originalPiJournal({ app, session, row, record, guard: entry => {
    if (entry?.historyProtection) throw Object.assign(Error('restricted original'), { historyAccessFailure: true });
  } }), /restricted original/);
  restriction = null;
  fs.renameSync(path.join(f.cwd, 'index.html'), path.join(f.cwd, 'index.offline'));
  await history.prepareContinuation(id, { refresh: true });
  assert.ok(!(await store.deviceHistory(id)).localPiOriginEvidenceVersion);
  fs.renameSync(path.join(f.cwd, 'index.offline'), path.join(f.cwd, 'index.html'));
  const diverged = structuredClone(record);
  diverged.prefix.tools.find(tool => tool.name === 'write').args.content = 'a different receipt';
  assert.equal(await native.originalPiJournal({ app, session, row, record: diverged, guard() {} }), null);
  const restored = await history.prepareContinuation(id, { refresh: true });
  assert.equal(restored.artifactHistory.archive.generation, prior.archive.generation);
  const versions = restored.artifactHistory.archive.versions;
  for (const [turn, content] of [['old-website', 'original'], ['new-website', 'latest']]) {
    const version = versions.find(item => item.turnId === turn && item.relative === 'index.html');
    assert.ok(version);
    const directory = archive.location(f.workRoot, id, { version: 1, generation: version.generation });
    assert.equal(fs.readFileSync(path.join(directory, version.relative), 'utf8'), content);
  }
  const after = reads;
  await history.prepareContinuation(id, { refresh: true });
  assert.equal(reads, after);
});

test('explicit workspaces require a matching local change receipt or a retained file version', async t => {
  const f = fixture(t), name = 'report.md', target = f.write(name, 'completed result');
  f.write('notes.md', 'unrelated');
  const bytes = fs.readFileSync(target), digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const journal = { cwd: f.cwd, turnId: 'one', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, hash: digest, size: bytes.length } }] };
  const index = await project.capture({ ...f, journal });
  assert.deepEqual(index.items.map(item => item.metadata.relative), [name]);
  const directorySpelling = await project.capture({ ...f, journal: { ...journal, cwd: f.cwd + path.sep } });
  assert.deepEqual(directorySpelling.items, index.items);
  const kept = await project.capture({ ...f, retained: index });
  assert.equal(kept.items.length, 1);
  const alias = path.join(f.workRoot, 'linked-temp');
  fs.symlinkSync(path.dirname(f.cwd), alias, 'junction');
  assert.equal(await project.capture({ ...f, journal: { ...journal, cwd: path.join(alias, f.taskId) } }), null);
  assert.equal(await project.capture({ ...f, journal: { ...journal, cwd: f.workRoot } }), null);
  assert.equal(await project.capture({ ...f, journal: { ...journal, truncated: true } }), null);
  const previousStat = fs.statSync(target);
  f.write(name, 'different result');
  assert.equal(await project.capture({ ...f, journal }), null);
  // Equal-length writes can share a timestamp on Windows. Explicitly change
  // the version stamp for the retained-file check after rejecting the old hash.
  fs.utimesSync(target, previousStat.atime, new Date(previousStat.mtimeMs + 2000));
  assert.deepEqual(project.view(f.cwd, kept, () => {}).snapshot().items, []);
  const nextBytes = fs.readFileSync(target);
  const next = await project.capture({ ...f, journal: { ...journal, turnId: 'two', files: [{ ...journal.files[0],
    after: { ...journal.files[0].after, size: nextBytes.length, hash: crypto.createHash('sha256').update(nextBytes).digest('hex') } }] } });
  const updated = await project.capture({ ...f, previous: index, retained: next });
  assert.equal(project.view(f.cwd, updated, () => {}).snapshot().items.length, 1);
});

test('selected transfer outputs larger than a workspace journal entry receive a fresh local file receipt', async t => {
  const f = fixture(t), name = 'large.pdf', target = f.write(name, '');
  const block = Buffer.alloc(1024 * 1024), size = 32 * block.length + 1;
  fs.truncateSync(target, size);
  const hash = crypto.createHash('sha256');
  for (let i = 0; i < 32; i++) hash.update(block);
  const journal = { cwd: f.cwd, turnId: 'peer-transfer', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, hash: hash.update(block.subarray(0, 1)).digest('hex'), size } }] };
  assert.equal(await project.capture({ ...f, journal }), null);
  const received = await project.capture({ ...f, journal, verifiedTransfer: true });
  assert.deepEqual(received.items.map(item => item.metadata.relative), [name]);
  journal.files[0].after.hash = 'a'.repeat(64);
  assert.equal(await project.capture({ ...f, journal, verifiedTransfer: true }), null);
});

test('legacy receipts restore only the current verified skill revision as an installable card', async t => {
  const f = fixture(t);
  const bytes = require('../main/conversation/zip-archive').createEntriesSync([{ name: 'SKILL.md',
    bytes: Buffer.from('---\nname: history-example\ndescription: Local test skill\n---\n# Example\n') }]);
  const files = [];
  for (const [relative, content] of [['v1/demo.skill', bytes], ['v2/demo.skill', bytes],
    ['delivery/portable.zip', bytes], ['delivery/invalid.skill', Buffer.from('invalid')]]) {
    const target = f.write(relative, content);
    fs.utimesSync(target, 1000 + files.length, 1000 + files.length);
    files.push({ path: relative, action: 'created', after: { path: relative, exists: true, size: content.length,
      hash: crypto.createHash('sha256').update(content).digest('hex') } });
  }
  f.write('unrelated.skill', bytes);
  const saved = await project.capture({ ...f, journal: { cwd: f.cwd, turnId: 'finished', files } });
  assert.ok(saved.items.every(record => !record.metadata.pluginDraft));
  const view = project.view(f.cwd, saved, () => {});
  const results = runtime.decorate('preview', await view.snapshotAsync());
  const current = results.find(item => item.relative === 'v2/demo.skill');
  assert.equal(current.pluginName, 'history-example');
  assert.equal(current.pluginInstallable, true);
  assert.equal(current.pluginIdentity, 'skill:history-example');
  assert.equal(results.find(item => item.relative === 'v1/demo.skill').pluginSuperseded, true);
  assert.equal(results.find(item => item.relative.endsWith('.zip')).pluginDraft, undefined);
  assert.equal(results.find(item => item.relative.endsWith('invalid.skill')).pluginValidation.state, 'invalid');
  assert.equal(results.some(item => item.relative === 'unrelated.skill'), false);
  const resumed = { cwd: f.cwd, sessionId: 'resumed', outputSnapshot: () => ({ files: [] }),
    artifactHistory: require('../main/conversation/runtime-artifacts.cjs').forContinuation(f.cwd, saved) };
  const active = (await runtime.snapshotAsync(resumed)).items.filter(item => item.path === path.join(f.cwd, current.relative));
  assert.equal(active.length, 1);
  assert.equal(active[0].artifactId, current.artifactId);
  assert.equal(active[0].pluginValidation?.state, 'ready');
  f.write('v2/demo.skill', bytes);
  assert.ok(!(await view.snapshotAsync()).items.some(item => item.relative === 'v2/demo.skill'));
});

test('SQLite history opened by a second local account keeps verified outputs after native cleanup', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot }, { identity } = require('./helpers/platform-session-fixture.cjs');
  const a = identity(), b = identity('two'); let current = a;
  const archive = path.join(f.workRoot, 'pi-agent', 'sessions', 'one.jsonl');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, [
    { type: 'session', id: 'one', cwd: f.cwd },
    { type: 'message', message: { role: 'user', content: 'Synthetic task' } },
    { type: 'message', message: { role: 'assistant', content: 'Synthetic answer' } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const row = { id: 'one', adapterId: 'pi', path: archive, cwd: f.cwd, count: 2,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(a), creator: { account: 'one', hub: a.hub } };
  const session = { historyEntry: async () => fs.existsSync(archive) ? { ok: true, entry: row } : { ok: false, notFound: true },
    archivedConversation: async () => null, findBySessionId: () => null };
  const store = require('../main/conversation/replica-store.cjs').create(path.join(f.workRoot, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => current });
  await history.register([row]);
  const target = f.write('report.md', 'result'), name = path.basename(target), bytes = fs.readFileSync(target);
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  await history.backfill(row.id, { journal: { cwd: f.cwd, turnId: 'one', files: [{ path: name, action: 'created',
    after: { path: name, exists: true, size: bytes.length, hash: digest } }] } });
  const local = (await store.deviceHistory(row.id)).localArtifactHistory;
  assert.equal(local.items.length, 1);
  assert.equal(local.archive.files.length, 1);
  assert.equal(JSON.stringify(await history.exportPortable(row.id)).includes('localArtifactHistory'), false);
  // Simulate an upgrade from a receipts-only replica after native history cleanup.
  const stored = await store.deviceHistory(row.id), catalog = await store.get(row.id);
  const { archive: formerArchive, ...legacy } = stored.localArtifactHistory;
  const { digest: formerDigest, savedAt, ...prior } = stored;
  await store.saveDeviceHistory(row.id, { ...prior, localArtifactHistory: legacy }, {
    expectedRevision: catalog.replicaRevision, expectedHistoryDigest: formerDigest });
  await require('../main/conversation/device-artifact-archive.cjs').discard(f.workRoot, row.id, formerArchive.generation);
  fs.unlinkSync(archive); current = b;
  await history.projectRows([]);
  const deadline = Date.now() + 5000;
  while (!(await store.deviceHistory(row.id)).localArtifactHistory.archive && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok((await store.deviceHistory(row.id)).localArtifactHistory.archive, 'Opening the history list upgrades old receipts');
  fs.rmSync(f.cwd, { recursive: true });
  const view = await history.open(row.id, { historyPreview: true, allowContinuation: true });
  assert.equal(view.cwd, undefined);
  const index = await runtime.snapshotAsync(view), id = index.items[0].artifactId;
  assert.equal((await runtime.action(view, view.ref, id, 'read', {})).text, 'result');
  const recovery = await history.prepareContinuation(row.id);
  assert.equal(recovery.artifactHistory.items[0].metadata.relative, name);
  // A continued segment may have a fresh workspace after the original was cleaned.
  const nextCwd = path.join(f.workRoot, 'new-workspace');
  fs.mkdirSync(nextCwd);
  const currentFile = path.join(nextCwd, 'new.txt');
  fs.writeFileSync(currentFile, 'new result');
  const live = { cwd: nextCwd, outputs: () => [{ path: currentFile, name: 'new.txt', size: 10, at: Date.now() }] };
  history.bindContinuationArtifacts(live, recovery, () => {});
  const display = await runtime.viewSnapshotAsync(live);
  const old = display.items.find(item => item.artifactId === id);
  assert.equal(old.relative, name);
  assert.equal(old.primary, false);
  assert.equal(old.changedInTurn, false);
  assert.equal(runtime.decorate('active', { items: [old] })[0].archivedReadOnly, true);
  assert.equal(display.delivery.items.some(item => item.artifactId === id), false);
  assert.equal(display.got.files.some(item => item.path === old.path), false);
  assert.equal((await runtime.snapshotAsync(live)).items.some(item => item.artifactId === id), false);
  assert.equal((await runtime.action(live, 'active', id, 'read', {})).text, 'result');
  assert.equal((await runtime.action(live, 'active', id, 'share', {})).ok, false);
  assert.equal((await runtime.action(live, 'active', id, 'reveal', {})).ok, false);
  assert.equal((await runtime.resolveAsync(live, id)).ok, false);
  const newFile = display.items.find(item => item.relative === 'new.txt');
  assert.equal((await runtime.action(live, 'active', newFile.artifactId, 'read', {})).text, 'new result');
  const colliding = path.join(nextCwd, name);
  fs.writeFileSync(colliding, 'later');
  live.outputs = () => [{ path: colliding, name, size: 5, at: Date.now() }];
  assert.equal((await runtime.viewSnapshotAsync(live)).items.filter(item => item.artifactId === id).length, 1);
  assert.equal((await runtime.action(live, 'active', id, 'read', {})).text, 'later');
  live.outputs = () => [];
  assert.equal((await history.open(row.id)).historyArtifacts, undefined);
  current = a;
  await assert.rejects(runtime.action(live, 'active', id, 'read', {}), /账号|会话/);
  await assert.rejects(runtime.action(view, view.ref, id, 'read', {}), /账号|会话/);
  const next = await history.open(row.id, { historyPreview: true });
  assert.equal((await runtime.snapshotAsync(next)).items.length, 1);
  const saved = await store.deviceHistory(row.id), latest = await store.get(row.id);
  await store.saveDeviceHistory(row.id, { snapshot: saved.snapshot, coverage: saved.coverage, historyProtection: 'account' },
    { expectedRevision: latest.replicaRevision });
  await assert.rejects(runtime.snapshotAsync(next), /版本|归属/);
});

test('an older file inventory can add a package and its private resource receipts from the original journal', async t => {
  const f = fixture(t);
  const archive = 'export/example.soduwork-plugin', script = 'author/scripts/check.py';
  const files = [archive, script, 'report.md'].map(relative => {
    const bytes = Buffer.from('Synthetic fixture');
    f.write(relative, bytes);
    return { path: relative, action: 'created', after: { exists: true, path: relative, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
  const journal = { cwd: f.cwd, turnId: 'done', files };
  const old = await project.capture({ ...f, journal: { ...journal, files: files.slice(2) } });
  delete old.packageRecordedUntil;
  delete old.packageTurnId;
  const unchanged = await project.capture({ ...f, previous: old });
  assert.deepEqual(unchanged.items.map(row => row.metadata.relative), ['report.md']);
  const updated = await project.capture({ ...f, previous: unchanged, journal });
  assert.ok(updated.items.some(row => row.metadata.relative === archive));
  assert.ok(updated.resources.some(row => row.metadata.relative === script));
  const reader = project.view(f.cwd, updated, () => {});
  assert.equal(reader.verify(path.join(f.cwd, script)), false);
  assert.equal(reader.snapshot().items.some(item => item.relative === script), false);
});

function archiveSetup(t) {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const fileStamp = require('../main/conversation/runtime-artifacts.cjs').stamp;
  const row = (relative, content) => {
    const target = f.write(relative, content), stat = fs.lstatSync(target, { bigint: true });
    return { metadata: { relative, size: Number(stat.size) }, stamp: fileStamp(stat) };
  };
  const save = (items, previous, guard = () => {}) => storage.preserve(f.workRoot, f.row.id,
    { root: f.cwd, items, resources: [] }, previous, guard);
  const root = history => storage.projection(f.workRoot, f.row.id, history).root;
  return { ...f, row, save, root, storage };
}

for (const change of ['final timestamp', 'replaced file', 'modified bytes']) {
  test('archive verifies the closed writer after ' + change, async t => {
    const f = archiveSetup(t), row = f.row('result.txt', 'original');
    const promises = require('node:fs/promises'), open = promises.open.bind(promises);
    t.mock.method(promises, 'open', async (file, flags, ...args) => {
      const handle = await open(file, flags, ...args);
      if (flags !== 'wx' || path.basename(file) !== 'result.txt') return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        if (change === 'replaced file') {
          await promises.rename(file, file + '.old');
          await promises.writeFile(file, 'original');
        }
        if (change === 'modified bytes') await promises.writeFile(file, 'tampered');
        // Windows can finalize the last-write timestamp when the writer closes.
        await promises.utimes(file, 1000, 1000);
      };
      return handle;
    });
    if (change !== 'final timestamp') {
      await assert.rejects(f.save([row]), /Artifact archive file changed/);
      return;
    }
    const history = await f.save([row]);
    const archived = history.archive.files[0], root = f.root(history);
    assert.equal((await f.storage.readVersion(root, archived.relative, archived.stamp))?.toString(), 'original');
  });
}

test('archived history uses the canonical profile path and rejects links inside the generation', async t => {
  const f = archiveSetup(t), source = f.row('result.txt', 'archived');
  const profile = path.join(f.workRoot, 'profile');
  fs.mkdirSync(profile);
  const saved = await f.storage.preserve(profile, 'one',
    { version: 1, root: f.cwd, items: [{ ...source, metadata: { ...source.metadata,
      artifactId: 'output', kind: 'document' } }], resources: [] }, null, () => {});
  fs.rmSync(f.cwd, { recursive: true });
  // TEMP on Windows can use an 8.3 spelling. A trusted ancestor alias exercises
  // the same distinction between a profile's spelling and its native realpath.
  const aliasRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-profile-alias-'));
  t.after(() => fs.rmSync(aliasRoot, { recursive: true, force: true }));
  const alias = path.join(aliasRoot, 'ancestor');
  fs.symlinkSync(f.workRoot, alias, 'junction');
  const throughAlias = path.join(alias, 'profile');
  const archived = project.archivedView(throughAlias, 'one', f.cwd, saved, () => {}, () => {});
  assert.deepEqual(archived.snapshot().items.map(item => fs.readFileSync(item.path, 'utf8')), ['archived']);
  const generation = f.storage.projection(profile, 'one', saved).root;
  fs.renameSync(generation, generation + '-outside');
  fs.symlinkSync(generation + '-outside', generation, 'junction');
  assert.equal(f.storage.projection(throughAlias, 'one', saved), null);
});

test('archive repairs missing and changed files from their exact workspace receipts', async t => {
  const f = archiveSetup(t), rows = [f.row('shots/menu.png', 'pixels'), f.row('index.html', 'site')];
  const first = await f.save(rows);
  fs.unlinkSync(path.join(f.root(first), 'shots/menu.png'));
  fs.writeFileSync(path.join(f.root(first), 'index.html'), 'oops');
  const restored = await f.save(rows, first);
  assert.notEqual(restored.archive.generation, first.archive.generation);
  assert.equal(fs.readFileSync(path.join(f.root(restored), 'shots/menu.png'), 'utf8'), 'pixels');
  assert.equal(fs.readFileSync(path.join(f.root(restored), 'index.html'), 'utf8'), 'site');
});

test('archive still consults the original when a previous receipt disappeared during extension', async t => {
  const f = archiveSetup(t), firstRow = f.row('a.txt', 'a');
  const first = await f.save([firstRow]);
  fs.unlinkSync(path.join(f.root(first), 'a.txt'));
  const restored = await f.save([firstRow, f.row('b.txt', 'b')], first);
  assert.deepEqual(restored.archive.files.map(row => row.relative), ['a.txt', 'b.txt']);
});

test('publication and cleanup refuse a replaced generation', async t => {
  const f = archiveSetup(t), rows = [f.row('a.txt', 'a')];
  const storage = path.join(f.workRoot, 'conversation-artifacts');
  let foreign;
  function swap() {
    if (foreign || !fs.existsSync(storage)) return;
    const base = path.join(storage, fs.readdirSync(storage)[0]);
    const name = fs.readdirSync(base)[0];
    if (!name) return;
    const current = path.join(base, name);
    if (!fs.existsSync(path.join(current, 'a.txt'))) return;
    fs.renameSync(current, current + '.replaced');
    fs.mkdirSync(current);
    foreign = path.join(current, 'foreign.txt');
    fs.writeFileSync(foreign, 'preserve replacement');
  }
  await assert.rejects(f.save(rows, null, swap));
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve replacement');
});

test('archive limits use actual recorded bytes even when a metadata size is stale', async t => {
  const f = archiveSetup(t), wrong = f.row('wrong.txt', '123456');
  wrong.metadata.size = 0;
  const archived = await f.save([wrong, f.row('right.txt', 'ok')]);
  assert.deepEqual(archived.archive.files.map(row => row.relative), ['right.txt']);
  assert.equal(archived.archive.omitted, 1);
});

test('archive keeps committed output when another file has disappeared from both sources', async t => {
  const f = archiveSetup(t), rows = [f.row('shots/menu.png', 'image'), f.row('index.html', 'site')];
  const prior = await f.save(rows), old = f.root(prior);
  fs.unlinkSync(path.join(f.cwd, 'shots/menu.png'));
  fs.unlinkSync(path.join(old, 'shots/menu.png'));
  fs.unlinkSync(path.join(f.cwd, 'index.html'));
  const recovered = await f.save(rows, prior);
  assert.equal(recovered.archive.omitted, 1);
  assert.equal(recovered.archive.generation, prior.archive.generation);
  assert.equal(recovered.archivePending, true);
  assert.deepEqual(recovered.archive.files.filter(row => fs.existsSync(path.join(old, row.relative))).map(row => row.relative), ['index.html']);
  assert.equal(recovered.archive.files.find(row => row.relative === 'shots/menu.png').sha256,
    prior.archive.files.find(row => row.relative === 'shots/menu.png').sha256);
  assert.equal(fs.readFileSync(path.join(f.root(recovered), 'index.html'), 'utf8'), 'site');
});

test('a directory flush failure cannot publish or delete a previous generation', { skip: process.platform === 'win32' }, async t => {
  const f = archiveSetup(t), row = f.row('a.txt', 'a'), prior = await f.save([row]);
  const old = f.root(prior);
  const promises = require('node:fs/promises'), open = promises.open.bind(promises);
  t.mock.method(promises, 'open', async (...args) => {
    if (typeof args[1] === 'number' && (args[1] & fs.constants.O_DIRECTORY))
      return { sync: async () => { throw Error('simulated directory flush failure'); }, close: async () => {} };
    return open(...args);
  });
  await assert.rejects(f.save([row, f.row('nested/b.txt', 'b')], prior), /simulated directory flush failure/);
  assert.equal(fs.readFileSync(path.join(old, 'a.txt'), 'utf8'), 'a');
  assert.deepEqual(fs.readdirSync(path.dirname(old)), [prior.archive.generation]);
});

test('cleanup failures preserve the original scope or storage error', async t => {
  const f = archiveSetup(t), row = f.row('a.txt', 'a');
  const promises = require('node:fs/promises');
  const denial = Object.assign(Error('account changed'), { historyAccessFailure: true });
  t.mock.method(promises, 'rm', async () => { throw Object.assign(Error('busy'), { code: 'EBUSY' }); });
  await assert.rejects(f.save([row], null, () => {
    if (fs.existsSync(path.join(f.workRoot, 'conversation-artifacts'))) throw denial;
  }), error => {
    assert.equal(error, denial);
    assert.equal(error.cleanupFailure, 'EBUSY');
    return true;
  });
});

test('moving to a new work directory preserves old archived outputs without granting access there', async t => {
  const f = fixture(t), archive = require('../main/conversation/device-artifact-archive.cjs');
  const next = path.join(f.workRoot, 'another-project');
  fs.mkdirSync(next);
  async function capture(cwd, relative, data, previous) {
    fs.writeFileSync(path.join(cwd, relative), data);
    const journal = { cwd, turnId: crypto.randomUUID(), files: [{ action: 'created', path: relative,
      after: { exists: true, path: relative, size: Buffer.byteLength(data), hash: crypto.createHash('sha256').update(data).digest('hex') } }] };
    const current = await project.capture({ row: { ...f.row, cwd }, journal, previous });
    return archive.preserve(f.workRoot, f.row.id, archive.retain(previous, current), previous, () => {});
  }
  const first = await capture(f.cwd, 'history.txt', 'first');
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(path.join(next, 'history.txt'), 'other project file');
  const latest = await capture(next, 'second.txt', 'second', first);
  const live = project.view(next, latest, () => {});
  assert.equal(live.verify(path.join(next, 'history.txt')), false);
  const archived = project.archivedView(f.workRoot, f.row.id, next, latest, () => {}, () => {});
  assert.deepEqual(archived.snapshot().items.map(item => fs.readFileSync(item.path, 'utf8')).sort(), ['first', 'second']);
});

test('a continued website serves only verified historical resources and revokes its running preview on scope change', async t => {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const files = [['site/index.html', '<link rel="stylesheet" href="style.css">'], ['site/style.css', 'body{}'],
    ['site/shot.png', Buffer.from([137, 80, 78, 71])]].map(([name, content]) => {
    const bytes = Buffer.from(content);
    f.write(name, bytes);
    return { action: 'created', path: name, after: { exists: true, path: name, size: bytes.length,
      hash: crypto.createHash('sha256').update(bytes).digest('hex') } };
  });
  const indexed = await project.capture({ ...f, journal: { cwd: f.cwd, turnId: 'previous', files } });
  const archived = await storage.preserve(f.workRoot, f.row.id, indexed, null, () => {});
  const saved = storage.projection(f.workRoot, f.row.id, archived);
  let active = true;
  const guard = () => { if (!active) throw Error('scope changed'); };
  const reader = project.view(saved.root, saved, guard);
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(path.join(saved.root, 'site', 'not-recorded.txt'), 'private');
  const replacement = path.join(f.workRoot, 'next');
  fs.mkdirSync(replacement);
  const handle = { cwd: replacement, outputs: () => [] };
  runtime.bindContinuationArchive(handle, async () => reader);
  const result = await runtime.viewSnapshotAsync(handle);
  assert.equal(result.delivery.items.length, 0);
  const website = result.items.find(item => item.kind === 'website');
  const shot = result.items.find(item => item.kind === 'image');
  assert.equal((await runtime.decorateForSharing('stable', { items: [website] }))[0].websiteDirectoryId, undefined);
  assert.equal((await runtime.action(handle, 'stable', shot.artifactId, 'image-full', {})).data, 'iVBORw==');
  const ref = 'active-history-archive'; t.after(() => runtime.closeRef(ref));
  const preview = await runtime.preview(handle, ref, website.artifactId);
  assert.equal(preview.ok, true);
  assert.equal(await (await fetch(new URL('style.css', preview.url))).text(), 'body{}');
  assert.equal((await fetch(new URL('not-recorded.txt', preview.url))).status, 404);
  assert.equal((await runtime.action(handle, ref, website.artifactId, 'share-related', {})).ok, false);
  active = false;
  assert.equal((await fetch(preview.url)).status, 404);
});

test('deleting an archived chat detaches only its files and reclaims interrupted deletions', async t => {
  const f = fixture(t), storage = require('../main/conversation/device-artifact-archive.cjs');
  const first = archiveSetup(t), previous = await first.save([first.row('notes.txt', 'keep')]);
  const keep = first.root(previous);
  const store = path.join(f.workRoot, 'conversation-artifacts');
  const session = 'deleted-chat';
  const directory = path.join(store, crypto.createHash('sha256').update(session).digest('hex'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'synthetic'), '');
  const interrupted = path.join(store, 'removed-' + crypto.randomUUID());
  fs.mkdirSync(interrupted);
  await storage.detach(f.workRoot, session);
  assert.equal(fs.existsSync(directory), false);
  await storage.reclaim(f.workRoot);
  assert.equal(fs.existsSync(interrupted), false);
  assert.ok(fs.existsSync(path.join(keep, 'notes.txt')));
});

test('existing recoverable bytes take priority over later receipts at the file-count limit', async t => {
  const f = archiveSetup(t), old = f.row('last.txt', 'saved'), prior = await f.save([old]);
  fs.unlinkSync(path.join(f.cwd, 'last.txt'));
  const newRows = Array.from({ length: 4000 }, (_, i) => ({ ...old,
    metadata: { ...old.metadata, relative: 'new-' + i + '.txt' } }));
  const after = await f.save([...newRows, old], prior);
  assert.equal(after.archive.generation, prior.archive.generation);
  assert.equal(after.archive.omitted, 4000);
  assert.equal(fs.readFileSync(path.join(f.root(after), 'last.txt'), 'utf8'), 'saved');
});

test('a missing replacement keeps its older archived revision and can later publish the new bytes', async t => {
  const f = archiveSetup(t), old = f.row('result.txt', 'old saved bytes'), prior = await f.save([old]);
  const updated = f.row('result.txt', 'new bytes'), held = path.join(f.cwd, 'held.txt');
  fs.renameSync(path.join(f.cwd, 'result.txt'), held);
  const missing = await f.save([updated, f.row('other.txt', 'other')], prior);
  assert.equal(missing.archive.omitted, 1);
  assert.equal(fs.readFileSync(path.join(f.root(missing), 'result.txt'), 'utf8'), 'old saved bytes');
  assert.ok(missing.items.some(row => row.archiveOnly && row.metadata.relative === 'result.txt'));
  assert.ok(missing.items.some(row => !row.archiveOnly && row.metadata.relative === 'result.txt'));
  const back = f.row('result.txt', 'restored version'), recovered = await f.save([back], missing);
  assert.equal(recovered.archive.omitted, 0);
  assert.ok(!recovered.items.some(row => row.archiveOnly && row.metadata.relative === 'result.txt'));
  assert.equal(fs.readFileSync(path.join(f.root(recovered), 'result.txt'), 'utf8'), 'restored version');
});

test('an unchanged unavailable source keeps the current generation until more bytes are verifiable', async t => {
  const f = archiveSetup(t);
  const rows = [f.row('report.txt', 'report'), f.row('missing.txt', 'missing')];
  fs.unlinkSync(path.join(f.cwd, 'missing.txt'));
  const first = await f.save(rows);
  const second = await f.save(rows, first);
  assert.equal(second.archive.generation, first.archive.generation);
  assert.equal(second.archive.omitted, 1);
  const latest = await f.save([rows[0], f.row('missing.txt', 'replacement')], second);
  assert.notEqual(latest.archive.generation, first.archive.generation);
  assert.equal(latest.archive.omitted, 0);
});

test('four retained sparse 128 MiB files reserve the byte budget ahead of a new one-byte output', async t => {
  const f = archiveSetup(t), initial = await f.save([f.row('stub.txt', 'stub')]);
  const copyRoot = f.root(initial), rows = [], files = [], size = 128 * 1024 * 1024;
  const stamp = require('../main/conversation/runtime-artifacts.cjs').stamp;
  const hash = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024);
  for (let n = 0; n < 128; n++) hash.update(block);
  const sha256 = hash.digest('hex');
  for (let n = 0; n < 4; n++) {
    const relative = 'archived-' + n + '.txt';
    const file = path.join(copyRoot, relative), original = path.join(f.cwd, relative);
    for (const target of [file, original]) {
      const fd = fs.openSync(target, 'wx');
      try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
    }
    const sourceStamp = stamp(fs.statSync(original, { bigint: true }));
    files.push({ relative, sha256, sourceStamp, stamp: stamp(fs.statSync(file, { bigint: true })) });
    rows.push({ metadata: { relative, size }, stamp: sourceStamp, archiveOnly: true });
    fs.unlinkSync(original);
  }
  const prior = { ...initial, items: rows, archive: { ...initial.archive, files } };
  const fresh = f.row('new.txt', 'x');
  const latest = await f.save([fresh, ...rows], prior);
  assert.equal(latest.archive.generation, prior.archive.generation);
  assert.deepEqual(latest.archive.files.map(row => row.relative), files.map(row => row.relative));
  assert.equal(latest.archive.omitted, 1);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'new.txt'), 'utf8'), 'x');
  fs.unlinkSync(path.join(copyRoot, files[0].relative));
  const offline = await f.save([fresh, ...rows], latest);
  assert.equal(offline.archive.generation, prior.archive.generation);
  assert.equal(offline.archivePending, true);
  assert.equal(offline.archive.omitted, 2);
});

async function legacyReportHistory(t, complete) {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const row = { id: 'legacy-report', adapterId: 'opencode', cwd: f.cwd, count: 2,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity),
    creator: { account: 'one', hub: identity.hub } };
  const name = 'guide.html', html = '<title>Travel guide</title><h1>Original</h1>';
  f.write(name, html);
  const receipts = await project.capture({ row, journal: { cwd: f.cwd, turnId: 'legacy-scan',
    files: [{ path: name, action: 'created', after: { exists: true, path: name,
      size: Buffer.byteLength(html), hash: crypto.createHash('sha256').update(html).digest('hex') } }] } });
  history = require('../main/conversation/shared-history.cjs').create({ app, identityOf: () => identity,
    session: { historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null,
      findBySessionId: () => null }, store: require('../main/conversation/replica-store.cjs')
      .createWorker(path.join(f.workRoot, 'conversation-replicas', 'history.sqlite')) });
  const [entry] = await history.register([row]);
  const snapshot = { messages: [{ role: 'assistant', text: 'guide.html' }], tools: [] };
  await history.store.saveDeviceHistory(row.id, { localArtifactHistory: receipts,
    snapshot, coverage: { complete, sources: [] } },
  { expectedRevision: entry.replicaRevision });
  return { f, history, row, name, html, snapshot };
}

test('partial legacy conversation text does not hide a locally verified single-file delivery', async t => {
  const { f, history, row, name, html } = await legacyReportHistory(t, false);
  const view = await history.open(row.id, { historyPreview: true });
  const index = await runtime.viewSnapshotAsync(view);
  const pinned = index.items.filter(item => item.versionId);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].relative, name);
  f.write(name, '<title>Replacement</title>');
  const original = await require('../main/conversation/delivery-package-worker').prepare(view, [pinned[0].artifactId]);
  assert.equal(original.bytes.toString(), html);
  await view.close();
});

test('backfilling a file on a partial native read preserves the complete committed transcript', async t => {
  const { history, row, snapshot } = await legacyReportHistory(t, true);
  const messages = [...snapshot.messages, { role: 'assistant', text: 'partial native addition' }];
  t.mock.method(native, 'read', async () => { throw Object.assign(Error('native segment unavailable'), {
    code: 'NATIVE_SEGMENT_UNAVAILABLE', history: { snapshot: { ...snapshot, messages }, coverage: { complete: false, sources: [] } },
  }); });
  const view = await history.open(row.id, { historyPreview: true, allowContinuation: true });
  try {
    assert.equal(view.snapshot().execution.canContinueOnDevice, false);
    assert.deepEqual(view.snapshot().messages.map(message => message.text), messages.map(message => message.text));
    const saved = await history.store.deviceHistory(row.id);
    assert.ok(saved.localArtifactHistory.archive?.files.length);
    assert.deepEqual(saved.snapshot, snapshot);
    assert.deepEqual(saved.coverage, { complete: true, sources: [] });
    assert.equal(saved.nativeReadError, undefined);
  } finally { await view.close(); }
});

test('a rejected backfill retires its unpublished files without overwriting the existing body', async t => {
  const { f, history, row } = await legacyReportHistory(t, false);
  const stored = await history.store.deviceHistory(row.id);
  const archive = require('../main/conversation/device-artifact-archive.cjs');
  let generation, failWrite = true;
  t.mock.method(history.store, 'saveDeviceHistory', async (id, body, expected) => {
    assert.equal(expected.expectedHistoryDigest, stored.digest);
    generation = archive.location(f.workRoot, id, body.localArtifactHistory.archive);
    assert.ok(fs.existsSync(generation));
    if (failWrite) throw Error('SQLite write failed');
    return { ok: false, stale: true };
  });
  for (const failure of [/SQLite write failed/, { code: 'HISTORY_CONCURRENT_UPDATE' }]) {
    await assert.rejects(history.open(row.id, { historyPreview: true }), failure);
    assert.equal(fs.existsSync(generation), false);
    assert.deepEqual(await history.store.deviceHistory(row.id), stored);
    failWrite = false;
  }
});

test('a partial legacy archive can finish after restart when the original receipt becomes readable again', async t => {
  let history;
  const f = fixture(t, () => history?.close()), app = { getPath: () => f.workRoot };
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const row = { id: 'legacy-partial', adapterId: 'pi', cwd: f.cwd, count: 1,
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity),
    creator: { account: 'one', hub: identity.hub } };
  const open = () => require('../main/conversation/shared-history.cjs').create({ app, identityOf: () => identity,
    session: { historyEntry: async () => ({ ok: false, notFound: true }), archivedConversation: async () => null,
      findBySessionId: () => null }, store: require('../main/conversation/replica-store.cjs')
      .createWorker(path.join(f.workRoot, 'conversation-replicas', 'history.sqlite')) });
  const names = ['first.md', 'volume/second.md'];
  const files = names.map(name => {
    f.write(name, name);
    return { action: 'created', path: name, after: { exists: true, path: name, size: Buffer.byteLength(name),
      hash: crypto.createHash('sha256').update(name).digest('hex') } };
  });
  const receipts = await project.capture({ row, journal: { cwd: f.cwd, turnId: 'legacy-turn', files } });
  history = open();
  const [entry] = await history.register([row]);
  await history.store.saveDeviceHistory(row.id, { localArtifactHistory: receipts,
    snapshot: { messages: [{ role: 'user', text: 'Keep my outputs' }], tools: [] }, coverage: { complete: true, sources: [] } },
  { expectedRevision: entry.replicaRevision });
  const mounted = path.join(f.cwd, 'volume'), unmounted = path.join(f.workRoot, 'disconnected');
  fs.renameSync(mounted, unmounted);
  async function awaitArchived(count) {
    const end = Date.now() + 5000;
    let files;
    do {
      files = (await history.store.deviceHistory(row.id)).localArtifactHistory.archive?.files || [];
      if (files.length === count) break;
      await delay(10);
    } while (Date.now() < end);
    return files.map(item => item.relative).sort();
  }
  await history.projectRows([]);
  assert.deepEqual(await awaitArchived(1), [names[0]]);
  await history.close();
  fs.renameSync(unmounted, mounted);
  fs.unlinkSync(path.join(f.cwd, names[0]));
  history = open();
  await history.projectRows([]);
  assert.deepEqual(await awaitArchived(2), names);
  fs.rmSync(f.cwd, { recursive: true });
  const view = await history.open(row.id, { historyPreview: true });
  const result = await runtime.snapshotAsync(view);
  for (const name of names) {
    const item = result.items.find(item => item.relative === name);
    assert.equal((await runtime.action(view, view.ref, item.artifactId, 'read', {})).text, name);
  }
  await view.close();
});

test('new progress retains an unavailable prior generation until its original bytes can be authenticated again', async t => {
  const f = archiveSetup(t), store = require('../main/conversation/device-artifact-archive.cjs');
  const a = f.row('first.txt', 'first'), b = f.row('missing.txt', 'recoverable');
  const prior = await f.save([a, b]), old = f.root(prior), missing = path.join(old, b.metadata.relative);
  fs.unlinkSync(missing);
  fs.unlinkSync(path.join(f.cwd, b.metadata.relative));
  const added = f.row('later.txt', 'new'), next = await f.save([a, b, added], prior);
  assert.notEqual(next.archive.generation, prior.archive.generation);
  assert.equal(next.archive.pendingFiles[0].generation, prior.archive.generation);
  assert.equal(next.archive.pendingFiles[0].sha256, prior.archive.files.find(file => file.relative === b.metadata.relative).sha256);
  await store.retire(f.workRoot, 'runner-native-ref', prior.archive, next.archive, true);
  assert.ok(fs.existsSync(old));
  fs.rmSync(f.cwd, { recursive: true });
  fs.writeFileSync(missing, 'untrusted!!');
  const stale = await store.preserve(f.workRoot, 'runner-native-ref', next, next, () => {}, { readWorkspace: false });
  assert.equal(stale.archive.generation, next.archive.generation);
  fs.writeFileSync(missing, 'recoverable');
  const fixed = await store.preserve(f.workRoot, 'runner-native-ref', next, next, () => {}, { readWorkspace: false });
  assert.equal(fixed.archive.omitted, 0);
  assert.equal(fixed.archive.pendingFiles, undefined);
  assert.equal(fs.readFileSync(path.join(f.root(fixed), b.metadata.relative), 'utf8'), 'recoverable');
  await store.retire(f.workRoot, 'runner-native-ref', next.archive, fixed.archive, true);
  assert.ok(!fs.existsSync(old));
  assert.ok(!fs.existsSync(f.root(next)));
  assert.ok(fs.existsSync(f.root(fixed)));
});
