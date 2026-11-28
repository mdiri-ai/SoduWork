'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { create } = require('../main/conversation/local-delivery-archive');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-archive-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'), data = path.join(root, 'profile');
  await fs.mkdir(cwd); await fs.mkdir(data);
  await fs.writeFile(path.join(cwd, 'report.md'), '# Final report');
  await fs.writeFile(path.join(cwd, 'results.csv'), 'value\n42\n');
  const owner = 'fixture-owner';
  const handle = { cwd, sessionId: 'local', deliveryOwner: owner, snapshot: () => ({ status: 'idle' }),
    outputSnapshot: () => require('../main/pi-session/outputs').scan(cwd, 0, 1) };
  const indexed = require('../main/conversation/artifact-runtime').snapshot(handle);
  const ids = indexed.delivery.items.map(item => item.artifactId);
  const result = await require('../main/conversation/delivery-package').prepare(handle, ids);
  const app = { getPath: () => data };
  const target = path.join(data, 'delivery-archives', createHash('sha256').update(owner).digest('hex'),
    result.manifest.revision, result.filename);
  const calls = [], handlers = new Map(), frame = {};
  const event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false,
    getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href } };
  require('../main/conversation/local-delivery-action').install({ app,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    session: { get: ref => ref === 'local' ? handle : null }, ownerOf: () => owner,
    snapshotFiles: () => indexed,
    shell: { openPath: async file => { calls.push(['open', file]); return ''; },
      showItemInFolder: file => calls.push(['reveal', file]) } });
  return { target, result, calls, input: { app, owner, result, guard: async () => {} },
    action: name => handlers.get('conversation-delivery-' + name)(event, 'local', ids,
      { bundle: true, revision: result.manifest.revision }) };
}

for (const action of ['open-archive', 'open-local']) {
  test(`a partial archive write can be retried through ${action} without regenerating the delivery`, async t => {
    const f = await fixture(t), write = fs.writeFile;
    const failure = Object.assign(Error('disk full after a partial write'), { code: 'ENOSPC' });
    const fault = t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
      await write(file, bytes.subarray(0, 5), options);
      throw failure;
    });
    const failed = await f.action(action);
    assert.equal(failed.ok, false);
    assert.deepEqual(f.calls, [], 'a partial ZIP must never reach the shell');
    assert.equal(fault.mock.callCount(), 1, 'the real archive destination write was reached');
    fault.mock.restore();
    const leftover = await fs.readFile(f.target).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    const retried = await f.action(action);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(leftover, null, 'the failed write must release its own destination');
    assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
    assert.deepEqual(f.calls, [[action === 'open-archive' ? 'open' : 'reveal', f.target]]);
  });
}

test('valid cached ZIPs are reused and user-modified caches are retained but rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.action('open-archive')).ok, true);
  const past = new Date('2020-01-01T00:00:00Z');
  await fs.utimes(f.target, past, past);
  assert.equal((await f.action('open-local')).ok, true);
  assert.equal((await fs.stat(f.target)).mtimeMs, past.getTime(), 'reusing the archive does not rewrite it');
  const modified = Buffer.from(f.result.bytes); modified[modified.length - 1] ^= 1;
  await fs.writeFile(f.target, modified);
  assert.equal((await f.action('open-archive')).code, 'DELIVERY_ARCHIVE_INVALID');
  assert.equal(f.calls.length, 2, 'invalid cached bytes must never be opened');
  assert.deepEqual(await fs.readFile(f.target), modified, 'existing files are never deleted or replaced');
});

test('existing valid archives need no temporary write and failed exclusive opens own nothing', async t => {
  const f = await fixture(t);
  await create(f.input);
  const failure = Object.assign(Error('cannot open cache'), { code: 'EACCES' });
  const open = t.mock.method(fs, 'open', async () => { throw failure; });
  const unlink = t.mock.method(fs, 'unlink', async () => { throw Error('must not delete an unowned file'); });
  assert.equal(await create(f.input), f.target);
  assert.equal(open.mock.callCount(), 0);
  assert.equal(unlink.mock.callCount(), 0);
  assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
  unlink.mock.restore();
  await fs.unlink(f.target);
  const cleanup = t.mock.method(fs, 'unlink', async () => { throw Error('must not delete an unowned file'); });
  await assert.rejects(create(f.input), error => error === failure);
  assert.equal(cleanup.mock.callCount(), 0);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});

test('a close failure releases the newly written archive so the same revision can retry', async t => {
  const f = await fixture(t), open = fs.open;
  const failure = Object.assign(Error('close failed'), { code: 'EIO' });
  const fault = t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), close = file.close.bind(file);
    file.close = async () => { await close(); throw failure; };
    return file;
  });
  await assert.rejects(create(f.input), error => error === failure);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  fault.mock.restore();
  assert.equal(await create(f.input), f.target);
  assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
});

test('close and cleanup failures do not replace the original partial-write error', async t => {
  const f = await fixture(t), open = fs.open, write = fs.writeFile;
  const failure = Object.assign(Error('partial write failed'), { code: 'ENOSPC' });
  const opened = t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args), close = file.close.bind(file);
    file.close = async () => { await close(); throw Object.assign(Error('close failed'), { code: 'EIO' }); };
    return file;
  });
  const written = t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
    await write(file, bytes.subarray(0, 5), options);
    throw failure;
  });
  const cleanup = t.mock.method(fs, 'unlink', async () => { throw Object.assign(Error('cleanup denied'), { code: 'EACCES' }); });
  await assert.rejects(create(f.input), error => error === failure);
  assert.equal(cleanup.mock.callCount(), 1);
  const leftover = cleanup.mock.calls[0].arguments[0];
  assert.notEqual(leftover, f.target);
  assert.deepEqual(await fs.readFile(leftover), f.result.bytes.subarray(0, 5));
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  opened.mock.restore(); written.mock.restore(); cleanup.mock.restore();
  assert.equal(await create(f.input), f.target, 'an orphaned temporary file cannot poison a retry');
  assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
});

test('a replacement ZIP published during a failing write survives cleanup', async t => {
  const f = await fixture(t), write = fs.writeFile;
  const replacement = Buffer.from('independent ZIP bytes');
  const failure = Object.assign(Error('partial write failed'), { code: 'ENOSPC' });
  const fault = t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
    await write(file, bytes.subarray(0, 5), options);
    await fs.unlink(f.target).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await write(f.target, replacement, { flag: 'wx' });
    throw failure;
  });
  await assert.rejects(create(f.input), error => error === failure);
  fault.mock.restore();
  assert.deepEqual(await fs.readFile(f.target), replacement);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), [path.basename(f.target)]);
  await assert.rejects(create(f.input), { code: 'DELIVERY_ARCHIVE_INVALID' });
  assert.deepEqual(await fs.readFile(f.target), replacement);
});

for (const valid of [true, false]) {
  test(`a concurrently published ${valid ? 'valid' : 'different'} ZIP is never overwritten`, async t => {
    const f = await fixture(t), link = fs.link;
    const replacement = valid ? f.result.bytes : Buffer.from('different ZIP bytes');
    const fault = t.mock.method(fs, 'link', async (temporary, target) => {
      assert.equal(target, f.target);
      assert.deepEqual(await fs.readFile(temporary), f.result.bytes);
      await fs.writeFile(target, replacement, { flag: 'wx' });
      return link(temporary, target);
    });
    if (valid) assert.equal(await create(f.input), f.target);
    else await assert.rejects(create(f.input), { code: 'DELIVERY_ARCHIVE_INVALID' });
    assert.equal(fault.mock.callCount(), 1);
    assert.deepEqual(await fs.readFile(f.target), replacement);
    assert.deepEqual(await fs.readdir(path.dirname(f.target)), [path.basename(f.target)]);
  });
}

for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM']) {
  test(`a filesystem rejecting hard links with ${code} creates and reuses a complete ZIP`, async t => {
    const f = await fixture(t);
    t.mock.method(fs, 'link', async () => { throw Object.assign(Error('hard links unavailable'), { code }); });
    const target = await create(f.input);
    assert.equal(path.basename(target), f.result.filename);
    assert.equal(path.dirname(path.dirname(target)), path.dirname(path.dirname(f.target)), 'the cache stays under the same owner');
    assert.deepEqual(await fs.readFile(target), f.result.bytes);
    const past = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(target, past, past);
    const opened = t.mock.method(fs, 'open', async () => { throw Error('cached archives need no write'); });
    assert.equal(await create(f.input), target);
    assert.equal(opened.mock.callCount(), 0);
    assert.equal((await fs.stat(target)).mtimeMs, past.getTime());
  });
}

for (const action of ['open-archive', 'open-local']) {
  test(`a partial write retries through ${action} without hard-link support`, async t => {
    const f = await fixture(t), write = fs.writeFile;
    t.mock.method(fs, 'link', async () => { throw Object.assign(Error('hard links unavailable'), { code: 'ENOTSUP' }); });
    const fault = t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
      await write(file, bytes.subarray(0, 5), options);
      throw Object.assign(Error('disk full after a partial write'), { code: 'ENOSPC' });
    });
    assert.equal((await f.action(action)).ok, false);
    assert.deepEqual(f.calls, []);
    await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
    fault.mock.restore();
    const retried = await f.action(action);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0][0], action === 'open-archive' ? 'open' : 'reveal');
    assert.deepEqual(await fs.readFile(f.calls[0][1]), f.result.bytes);
  });
}

test('renamed bundles at the same revision retain both ZIPs without hard links', async t => {
  const f = await fixture(t);
  await create(f.input);
  t.mock.method(fs, 'link', async () => { throw Object.assign(Error('hard links unavailable'), { code: 'ENOTSUP' }); });
  assert.equal(await create(f.input), f.target, 'existing legacy archives keep their original path');
  const renamed = { ...f.input, result: { ...f.result, filename: 'Renamed delivery.zip' } };
  const renamedTarget = await create(renamed);
  assert.equal(path.basename(renamedTarget), renamed.result.filename);
  const again = { ...renamed, result: { ...renamed.result, filename: 'Another title.zip' } };
  const anotherTarget = await create(again);
  assert.equal(path.basename(anotherTarget), again.result.filename);
  assert.notEqual(renamedTarget, anotherTarget);
  for (const target of [f.target, renamedTarget, anotherTarget]) {
    assert.deepEqual(await fs.readFile(target), f.result.bytes);
  }
  assert.equal(await create(renamed), renamedTarget);
});

for (const valid of [true, false]) {
  test(`a concurrently published ${valid ? 'valid' : 'different'} fallback ZIP is never overwritten`, async t => {
    const f = await fixture(t), rename = fs.rename;
    const replacement = valid ? f.result.bytes : Buffer.from('independent ZIP bytes');
    t.mock.method(fs, 'link', async () => { throw Object.assign(Error('hard links unavailable'), { code: 'ENOTSUP' }); });
    let competingTarget;
    const fault = t.mock.method(fs, 'rename', async (staging, destination) => {
      assert.deepEqual(await fs.readdir(staging), [f.result.filename]);
      assert.deepEqual(await fs.readFile(path.join(staging, f.result.filename)), f.result.bytes);
      await fs.mkdir(destination);
      competingTarget = path.join(destination, f.result.filename);
      await fs.writeFile(competingTarget, replacement, { flag: 'wx' });
      return rename(staging, destination);
    });
    if (valid) assert.equal(await create(f.input), competingTarget);
    else await assert.rejects(create(f.input), { code: 'DELIVERY_ARCHIVE_INVALID' });
    assert.equal(fault.mock.callCount(), 1);
    assert.deepEqual(await fs.readFile(competingTarget), replacement);
    assert.deepEqual(await fs.readdir(path.dirname(competingTarget)), [f.result.filename]);
  });
}

test('a failed fallback publication preserves a concurrent legacy ZIP and can retry', async t => {
  const f = await fixture(t);
  const failure = Object.assign(Error('directory publication failed'), { code: 'EIO' });
  t.mock.method(fs, 'link', async () => { throw Object.assign(Error('hard links unavailable'), { code: 'ENOTSUP' }); });
  const fault = t.mock.method(fs, 'rename', async () => {
    await fs.writeFile(f.target, f.result.bytes, { flag: 'wx' });
    throw failure;
  });
  await assert.rejects(create(f.input), error => error === failure);
  assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
  fault.mock.restore();
  assert.equal(await create(f.input), f.target);
  assert.deepEqual(await fs.readFile(f.target), f.result.bytes);
});

test('an ordinary hard-link I/O failure is reported without attempting fallback publication', async t => {
  const f = await fixture(t);
  const failure = Object.assign(Error('link failed'), { code: 'EIO' });
  const link = t.mock.method(fs, 'link', async () => { throw failure; });
  const rename = t.mock.method(fs, 'rename', async () => { throw Error('unexpected fallback'); });
  await assert.rejects(create(f.input), error => error === failure);
  assert.equal(rename.mock.callCount(), 0);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
  link.mock.restore(); rename.mock.restore();
  assert.equal(await create(f.input), f.target);
});
