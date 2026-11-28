'use strict';
// A conversation returned to recent without a neighbor must not sink below older history.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../components/workspace/workspace-sidebar-state.js'), 'utf8');
function fixture() {
  const window = { SoduWorkPluginIcon: require('../core/plugin-icon') }, values = new Map();
  vm.runInNewContext(source, { window });
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  return window.WorkspaceSidebarState.create({ storage, key: 'one' });
}
const ids = rows => Array.from(rows, row => row.id);
// Newest first by time: c0 is the newest, c5 the oldest.
const rows = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, title: 'chat ' + i, at: 1000 - i }));
const row = id => rows.find(item => item.id === id);
function setup() {
  const s = fixture();
  const project = s.saveProject({ name: 'P', folders: [] });
  // A manual reorder switches recent to its stored order, as a real drag does.
  s.move(row('c3'), 'recent', 'c0', rows);
  s.move(row('c1'), project, '', rows);
  s.move(row('c4'), project, '', rows);
  return { s, project };
}

test('a recent drop without a neighbor puts the conversation first, not behind older history', () => {
  const { s, project } = setup();
  assert.deepEqual(ids(s.view(rows).projects.find(p => p.id === project).items), ['c1', 'c4']);
  s.move(row('c4'), 'recent', '', rows);
  assert.deepEqual(ids(s.view(rows).recent), ['c4', 'c3', 'c0', 'c2', 'c5']);
});

test('a recent drop on a row keeps the row position', () => {
  const { s } = setup();
  s.move(row('c4'), 'recent', 'c2', rows);
  assert.deepEqual(ids(s.view(rows).recent), ['c3', 'c0', 'c4', 'c2', 'c5']);
});

test('the first position also goes above conversations created after the last reorder', () => {
  const { s, project } = setup();
  const fresh = [{ id: 'new', title: 'new', at: 5000 }, ...rows];
  assert.equal(ids(s.view(fresh).recent)[0], 'new', 'a newer conversation starts on top');
  s.move(row('c1'), 'recent', '', fresh);
  assert.deepEqual(ids(s.view(fresh).recent).slice(0, 2), ['c1', 'new']);
  assert.ok(!ids(s.view(fresh).projects.find(p => p.id === project).items).includes('c1'));
});

test('projects and pinned keep appending without a neighbor', () => {
  const { s, project } = setup();
  s.move(row('c0'), project, '', rows);
  assert.deepEqual(ids(s.view(rows).projects.find(p => p.id === project).items), ['c1', 'c4', 'c0']);
  s.move(row('c2'), 'pinned', '', rows);
  s.move(row('c5'), 'pinned', '', rows);
  assert.deepEqual(ids(s.view(rows).pinned), ['c2', 'c5']);
});

test('unpinning returns the conversation to the top of a manually ordered recent list', () => {
  const { s } = setup();
  s.togglePin('c5', row('c5'));
  assert.deepEqual(ids(s.view(rows).pinned), ['c5']);
  s.togglePin('c5', row('c5'));
  assert.deepEqual(ids(s.view(rows).recent)[0], 'c5');
});

test('dropping a conversation on itself changes nothing', () => {
  const { s } = setup();
  const before = JSON.stringify(s.get());
  s.move(row('c0'), 'recent', 'c0', rows);
  assert.equal(JSON.stringify(s.get()), before);
});
