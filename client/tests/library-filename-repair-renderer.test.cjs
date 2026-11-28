'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/panels/panels-library.js'), 'utf8');

function fixture(answer) {
  const calls = [], prompts = [], errors = [], notifications = [], events = new Map();
  let finish;
  const pending = answer === undefined ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(answer);
  const context = {
    setTimeout, clearTimeout, console,
    addEventListener: (type, fn) => events.set(type, fn),
    document: {},
    SoduWorkLibraryDialogs: { create: () => ({
      openNameDialog: options => { prompts.push(options); return pending; },
      showError: async (error, fallback) => errors.push({ error, fallback }), close() {},
    }) },
    SoduWorkAPI: {
      repairLocalLibraryFilename: async (...args) => { calls.push(['repair', ...args]); },
      updateLibraryItem: async (...args) => { calls.push(['update', ...args]); },
    },
    SoduWorkLibraryFileIcons: { markup: () => '<svg></svg>' },
    petSay: value => notifications.push(value),
  };
  context.window = context;
  vm.createContext(context);
  const seam = '  global.openLibraryPanel = openLibraryPanel;';
  assert.equal(source.split(seam).length, 2);
  vm.runInContext(source.replace(seam, `
    load = async () => {};
    global.review = { state, renameItem, itemActions, itemRow };
${seam}`), context);
  return { ...context.review, context, calls, prompts, errors, notifications, finish,
    switchAccount: () => events.get('soduwork-data-scope-changed')(),
    button: { disabled: false, isConnected: true, hasAttribute: () => false } };
}

const local = { id: 'local-fixture', title: 'Visible title', filename: 'legacy.p', backend: 'local', kind: 'file', size: 12 };

test('only Rename is shown for ordinary and damaged local files', () => {
  const f = fixture('unused.pdf');
  for (const filenameIssue of [undefined, 'duplicate', 'invalid', 'check']) {
    const row = { ...local, filenameIssue };
    assert.match(f.itemActions(row), /data-library-rename="local-fixture"/);
    assert.doesNotMatch(f.itemActions(row), /data-library-repair-filename/);
    assert.doesNotMatch(f.itemRow(row), /library-filename-hint|请核对文件名/);
  }
  f.state.scope = 'trash';
  assert.doesNotMatch(f.itemActions(local), /data-library-rename|data-library-repair-filename/);
});

test('the original rename dialog submits the user-confirmed title for local and remote files', async () => {
  for (const row of [local, { ...local, filenameIssue: 'check' }, { ...local, id: 'remote-file', backend: 'nfs' }]) {
    const f = fixture('confirmed.pdf'); f.state.items = [row];
    await f.renameItem(f.button, row.id);
    assert.equal(f.prompts[0].title, '重命名文件');
    assert.equal(f.prompts[0].value, 'Visible title.p');
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls)), [['update', row.id, { title: 'confirmed.pdf' }]]);
    assert.equal(f.notifications.at(-1), '已重命名');
    assert.equal(f.button.disabled, false);
  }
});

test('cancelling or accepting the current visible name does not mutate the library', async () => {
  for (const answer of ['', 'Visible title.p']) {
    const f = fixture(answer); f.state.items = [local];
    await f.renameItem(f.button, local.id);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.notifications, []);
  }
});

test('a pending rename is cancelled after an account switch, listing removal or entry into trash', async () => {
  for (const invalidate of [f => f.switchAccount(), f => { f.state.items = []; }, f => { f.state.scope = 'trash'; }]) {
    const f = fixture(); f.state.items = [local];
    const operation = f.renameItem(f.button, local.id);
    assert.equal(f.prompts.length, 1);
    invalidate(f); f.finish('late.pdf');
    await operation;
    assert.deepEqual(f.calls, []); assert.deepEqual(f.notifications, []);
  }
});

test('failed rename retains the row, reports the error and releases the action', async () => {
  const f = fixture('duplicate.pdf'); f.state.items = [local];
  const failure = Error('The filename is already used');
  f.context.SoduWorkAPI.updateLibraryItem = async () => { throw failure; };
  await f.renameItem(f.button, local.id);
  assert.equal(f.state.items[0], local); assert.equal(f.errors[0].error, failure);
  assert.equal(f.errors[0].fallback, '重命名失败');
  assert.deepEqual(f.notifications, []); assert.equal(f.button.disabled, false);
});
