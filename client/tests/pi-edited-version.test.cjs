'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const runtime = require('../main/conversation/artifact-runtime');
const versions = require('../main/conversation/artifact-versions.cjs');
const current = path.join(__dirname, '..');
const released = process.env.SODUWORK_STOCK_CLIENT || current;

test('an already issued Pi draft and its final edit keep distinct bytes while only the final version is listed', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-edited-version-')));
  const id = randomUUID(), cwd = path.join(root, 'project'), file = path.join(root, 'pi-agent/sessions', id + '.jsonl');
  fs.mkdirSync(cwd); fs.mkdirSync(path.dirname(file), { recursive: true });
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  const row = { id, ref: 'old-project', cwd, adapterId: 'pi', path: file, count: 1, creator: { hub: identity.hub, account: 'one' },
    workOwner: require('../main/platform-connections/runtime.cjs').scope(identity) };
  const session = { historyEntry: async () => ({ ok: true, entry: row }), archivedConversation: async () => null, findBySessionId: () => null };
  let history, store;
  t.after(async () => { await history?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function start(client) {
    store = require(path.join(client, 'main/conversation/replica-store.cjs')).create(path.join(root, 'history.db'));
    history = require(path.join(client, 'main/conversation/shared-history.cjs')).create({
      app: { getPath: () => root }, session, store, identityOf: () => identity, workRoot: () => root });
  }
  const entries = [{ type: 'session', version: 3, id, cwd }];
  function message(value) {
    const number = entries.length;
    entries.push({ type: 'message', id: 'entry-' + number, timestamp: new Date(1700000000000 + number).toISOString(), message: value });
    row.count = number;
  }
  function call(name, args) {
    const key = 'tool-' + entries.length;
    message({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: key, name, arguments: args }] });
    message({ role: 'toolResult', toolCallId: key, toolName: name, isError: false, content: [{ type: 'text', text: 'done' }] });
  }
  const page = 'logo.htm', css = 'logo.css', draft = '<link rel="stylesheet" href="logo.css"><h1>Draft</h1>';
  const final = draft.replace('Draft', 'Final');
  fs.writeFileSync(path.join(cwd, page), draft); fs.writeFileSync(path.join(cwd, css), 'body{color:red}');
  message({ role: 'user', content: 'Create the logo' });
  call('write', { path: css, content: 'body{color:red}' });
  call('write', { path: page, content: draft });
  const writeLog = () => fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  writeLog(); start(released);
  history.observe({ ref: row.ref, sessionId: id, snapshot: () => ({ messages: [], tools: [] }), historyRow: () => row }, identity);
  await history.close();
  start(current);
  const earlier = await store.deviceHistory(id);
  const original = versions.list(earlier.localArtifactHistory.archive).find(entry => entry.relative === page);
  assert.ok(original);
  if (released === current) {
    const coverage = { ...earlier.coverage, sources: earlier.coverage.sources.map(s => ({ ...s, artifactEvidenceVersion: 2 })) };
    const { digest, savedAt, ...body } = earlier;
    const catalog = await store.get(id);
    assert.ok((await store.saveDeviceHistory(id, { ...body, coverage }, {
      expectedRevision: catalog.replicaRevision, expectedHistoryDigest: digest })).ok);
  }
  call('edit', { path: page, edits: [{ oldText: 'Draft', newText: 'Final' }] });
  fs.writeFileSync(path.join(cwd, page), final);
  message({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Completed logo.htm.' }] });
  writeLog();
  const view = await history.open(id, { historyPreview: true });
  const saved = await store.deviceHistory(id), archive = saved.localArtifactHistory.archive;
  const visible = versions.list(archive).filter(file => file.relative === page);
  assert.equal(visible.length, 1);
  assert.notEqual(visible[0].versionId, original.versionId);
  assert.equal(visible[0].turnId, original.turnId);
  async function bytes(handle, versionId) {
    const result = await runtime.resolveView(handle, 'version:' + versionId);
    assert.equal(result.ok, true, result.reason);
    return fs.readFileSync(result.path, 'utf8');
  }
  assert.equal(await bytes(view, original.versionId), draft);
  assert.equal(await bytes(view, visible[0].versionId), final);
  const indexed = await runtime.viewSnapshotAsync(view);
  assert.deepEqual(indexed.items.filter(file => file.versionId && file.relative === page).map(file => file.versionId), [visible[0].versionId]);
  await view.close(); await history.close(); start(current);
  fs.renameSync(cwd, cwd + '-moved');
  const reopened = await history.open(id, { historyPreview: true });
  assert.equal(await bytes(reopened, original.versionId), draft);
  assert.equal(await bytes(reopened, visible[0].versionId), final);
  const draftRef = 'older-' + id;
  try {
    const preview = await runtime.preview(reopened, draftRef, 'version:' + original.versionId);
    assert.ok(preview.ok, preview.reason);
    assert.equal(await (await fetch(preview.url)).text(), draft);
    assert.equal(await (await fetch(new URL(css, preview.url))).text(), 'body{color:red}');
  } finally { runtime.closeRef(draftRef); }
  const retained = await store.deviceHistory(id);
  assert.equal(retained.digest, saved.digest);
  assert.deepEqual(retained.localArtifactHistory.archive.versions, archive.versions);
  await reopened.close();
  const readers = await require(path.join(released, 'main/conversation/artifact-versions.cjs')).readers(root, id, archive, () => {});
  const published = readers.flatMap(group => group.reader.snapshot().items).filter(file => file.relative === page);
  assert.equal(published.length, 1);
  assert.equal(fs.readFileSync(published[0].path, 'utf8'), final);

  // A normal later user turn remains a separate immutable revision.
  fs.renameSync(cwd + '-moved', cwd);
  message({ role: 'user', content: 'Change the heading again.' });
  const laterBytes = final.replace('Final', 'Next');
  call('write', { path: page, content: laterBytes });
  message({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Updated logo.htm.' }] });
  fs.writeFileSync(path.join(cwd, page), laterBytes); writeLog();
  const updated = await history.backfill(id);
  const later = versions.list(updated.localArtifactHistory.archive).filter(file => file.relative === page);
  assert.equal(later.length, 2);
  assert.equal(new Set(later.map(file => file.turnId)).size, 2);
  const newest = await history.open(id, { historyPreview: true });
  assert.equal(await bytes(newest, original.versionId), draft);
  assert.equal(await bytes(newest, visible[0].versionId), final);
  assert.equal(await bytes(newest, later.find(file => file.turnId !== original.turnId).versionId), laterBytes);
  await newest.close();
});

test('a retired Pi edit replaces only its own issued draft alongside a later same-name workspace file', async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-pi-retired-edit-')));
  const id = randomUUID(), next = randomUUID(), origin = path.join(root, 'first'), active = path.join(root, 'second');
  let history;
  t.after(async () => { await history?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const sessions = path.join(root, 'pi-agent', 'sessions');
  for (const dir of [origin, active, sessions]) fs.mkdirSync(dir, { recursive: true });
  const page = 'index.html', initial = 'old draft', final = 'old final', newer = 'new project';
  const app = { getPath: () => root }, guard = () => {};
  const native = require('../main/conversation/device-history-native.cjs'), capture = require('../main/conversation/device-history-artifacts.cjs').capture;
  const storage = require('../main/conversation/device-artifact-archive.cjs'), segments = require('../main/conversation/runtime-segments');
  const identity = require('./helpers/platform-session-fixture.cjs').identity();
  function log(id, cwd, messages) {
    const file = path.join(sessions, id + '.jsonl');
    const entries = [{ type: 'session', id, cwd }, ...messages.map((message, index) => ({ type: 'message', id: 'm' + index, message }))];
    fs.writeFileSync(file, entries.map(entry => JSON.stringify(entry)).join('\n'));
    return { id, cwd, adapterId: 'pi', path: file };
  }
  function tool(name, args) {
    return [{ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: name, name, arguments: args }] },
      { role: 'toolResult', toolCallId: name, toolName: name, isError: false, content: [] }];
  }
  const done = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] };
  const first = [{ role: 'user', submissionId: 'old-turn', content: 'First' }, ...tool('write', { path: page, content: initial })];
  const old = log(id, origin, first), recent = log(next, active, [{ role: 'user', content: 'Second' }, done]);
  const session = { historyEntry: async (_, wanted) => ({ ok: true, entry: wanted === id ? old : recent }), findBySessionId: () => null };
  fs.writeFileSync(path.join(origin, page), initial);
  const initialJournal = (await require(path.join(released, 'main/conversation/device-history-native.cjs')).read({ app, session, row: old, guard })).localJournal;
  const firstCapture = await require(path.join(released, 'main/conversation/device-history-artifacts.cjs')).capture({ row: old, journal: initialJournal, nativePiEvidence: true });
  const draft = await require(path.join(released, 'main/conversation/device-artifact-archive.cjs')).preserve(root, id, firstCapture, null, guard);
  const [issued] = versions.list(draft.archive);
  assert.equal(issued.turnId, 'old-turn');
  log(id, origin, [...first, ...tool('edit', { path: page, oldText: initial, newText: final }), done]);
  fs.writeFileSync(path.join(origin, page), final);
  const finished = await native.read({ app, session, row: old, guard });
  const record = { version: 1, id, originAdapter: 'pi', segments: [], prefix: finished.snapshot, deviceHistoryComplete: true,
    active: { sessionId: next, adapterId: 'pi', ref: path.basename(active) }, cwd: active, owner: segments.scope(identity) };
  await segments.save(app, record);
  const row = { ...old, cwd: active, ref: path.basename(active), workOwner: record.owner, creator: { account: 'one', hub: identity.hub } };
  fs.writeFileSync(path.join(active, page), newer);
  const journal = { cwd: active, turnId: 'new-turn', userMessageIndex: finished.snapshot.messages.length, files: [
    { action: 'created', path: page, after: { path: page, exists: true, size: newer.length,
      hash: require('node:crypto').createHash('sha256').update(newer).digest('hex') } }] };
  const prior = await storage.preserve(root, id, await capture({ row, journal, verifiedTurn: true }), draft, guard);
  assert.equal(versions.list(prior.archive).length, 2);
  const store = require('../main/conversation/replica-store.cjs').create(path.join(root, 'history.sqlite'));
  history = require('../main/conversation/shared-history.cjs').create({ app, session, store, identityOf: () => identity, workRoot: () => root });
  const [registered] = await history.register([row]);
  const body = await native.read({ app, session, row, guard });
  assert.ok((await store.saveDeviceHistory(id, { ...body, localArtifactHistory: prior, localPiOriginReviewed: id,
    localPiOriginEvidenceVersion: 2 }, { expectedRevision: registered.replicaRevision })).ok);
  const restored = await history.prepareContinuation(id, { refresh: true });
  const result = restored.artifactHistory.archive;
  assert.equal(result.generation, prior.archive.generation);
  assert.equal(restored.artifactHistory.root, active);
  const stock = require(path.join(released, 'main/conversation/artifact-versions.cjs'));
  const visible = stock.list(result);
  assert.equal(visible.length, 2);
  const originals = await stock.readers(root, id, result, guard);
  const content = originals.flatMap(group => group.reader.snapshot().items.map(item => [group.turnId, fs.readFileSync(item.path, 'utf8')]));
  assert.deepEqual(content.sort(), [['new-turn', newer], ['old-turn', final]]);
  const [held] = await versions.readers(root, id, result, guard, guard, 'version:' + issued.versionId);
  assert.equal(fs.readFileSync(held.reader.snapshot().items[0].path, 'utf8'), initial);
  const nextRead = await history.prepareContinuation(id, { refresh: true });
  assert.deepEqual(nextRead.artifactHistory.archive.versions, result.versions);

  const verified = await capture({ row: old, journal: finished.localJournal, nativePiEvidence: true });
  const independent = await storage.preserve(root, id, verified, null, guard);
  for (const incorrect of [{ sessionId: next }, { adapterId: 'runner' }, { userMessageIndex: 99 }]) {
    const foreign = { ...prior.archive, versions: prior.archive.versions.map(file => file.versionId === issued.versionId
      ? { ...file, source: { ...file.source, ...incorrect } } : file) };
    assert.equal(versions.mergePiOrigin(foreign, independent.archive, verified), foreign);
  }
});
