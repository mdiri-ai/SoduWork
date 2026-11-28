'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { create } = require('../main/conversation/cloud-result-local');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-local-result-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'cloud'), data = path.join(root, 'app'), owner = 'fixture-owner';
  await fs.mkdir(directory); await fs.mkdir(data);
  const items = [];
  for (const relative of ['index.html', 'assets/style.css']) {
    const file = path.join(directory, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'source content for ' + relative);
    const stat = await fs.stat(file);
    items.push({ artifactId: relative, path: file, relative, name: path.basename(relative),
      size: stat.size, at: Math.round(stat.mtimeMs) });
  }
  const parent = path.join(data, 'local-results', createHash('sha256').update(owner).digest('hex'));
  await fs.mkdir(parent, { recursive: true });
  const existing = path.join(parent, 'result-existing');
  await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'notes.txt'), 'existing local edits');
  const input = { app: { getPath: () => data }, directory, owner, items, ids: ['index.html'], guard: async () => {} };
  const onlyExisting = async () => {
    assert.deepEqual(await fs.readdir(parent), ['result-existing']);
    assert.equal(await fs.readFile(path.join(existing, 'notes.txt'), 'utf8'), 'existing local edits');
    for (const item of items) assert.equal(await fs.readFile(item.path, 'utf8'), 'source content for ' + item.relative);
  };
  return { input, parent, onlyExisting };
}

test('a partial destination write removes only the unpublished local workspace', async t => {
  const f = await fixture(t), write = fs.writeFile;
  const failure = Object.assign(Error('disk full'), { code: 'ENOSPC' });
  t.mock.method(fs, 'writeFile', async (file, bytes, options) => {
    if (String(file).startsWith(f.parent + path.sep) && String(file).endsWith('style.css')) {
      await write(file, bytes.subarray(0, 3), options);
      throw failure;
    }
    return write(file, bytes, options);
  });
  await assert.rejects(create(f.input), error => error === failure);
  await f.onlyExisting();
});

test('ownership loss after copying releases the unreturned workspace', async t => {
  const f = await fixture(t);
  const failure = Error('account changed'); let guards = 0;
  await assert.rejects(create({ ...f.input, guard: async () => { if (++guards === 2) throw failure; } }),
    error => error === failure);
  await f.onlyExisting();
});

test('a failure while preparing the final file descriptor leaves no abandoned copy', async t => {
  const f = await fixture(t), stat = fs.stat;
  const failure = Object.assign(Error('destination unavailable'), { code: 'EIO' });
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (String(file).startsWith(f.parent + path.sep)) throw failure;
    return stat(file, ...args);
  });
  await assert.rejects(create(f.input), error => error === failure);
  await f.onlyExisting();
});

test('successful continuations retain independent workspaces and all supporting files', async t => {
  const f = await fixture(t);
  const first = await create(f.input), second = await create(f.input);
  assert.notEqual(first.cwd, second.cwd);
  assert.equal(first.ok, true); assert.equal(first.preview, true);
  assert.equal(await fs.readFile(path.join(first.cwd, 'assets/style.css'), 'utf8'), 'source content for assets/style.css');
  await fs.writeFile(first.file.path, 'local changes');
  assert.equal(await fs.readFile(second.file.path, 'utf8'), 'source content for index.html');
  assert.equal(await fs.readFile(f.input.items[0].path, 'utf8'), 'source content for index.html');
  assert.equal((await fs.readdir(f.parent)).length, 3);
});
