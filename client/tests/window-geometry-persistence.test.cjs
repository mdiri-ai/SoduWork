
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('quitting flushes the final geometry and maximized flag before the debounce', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sodu-geometry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = new EventEmitter(); app.getPath = () => dir;
  const tasks = new Map(); let next = 0;
  const module = { exports: {} };
  const filename = path.join(__dirname, '../main/window-geometry.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module,
    require: name => name === 'electron' ? { app, screen: {} } : name === './window-layout' ? {} : require(name),
    setTimeout: fn => { tasks.set(++next, fn); return next; }, clearTimeout: id => tasks.delete(id),
  }, { filename });
  const win = new EventEmitter();
  Object.assign(win, { isDestroyed: () => false, isMinimized: () => false, isMaximized: () => false,
    getBounds: () => ({ x: 42, y: 80, width: 1150, height: 780 }) });
  module.exports.remember('chat', win);
  win.emit('resize'); win.emit('close'); win.emit('maximize');
  const target = path.join(dir, 'window-geometry.json');
  assert.equal(fs.existsSync(target), false);
  assert.equal(tasks.size, 1);
  app.emit('will-quit');
  assert.equal(tasks.size, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).chat,
    { x: 42, y: 80, width: 1150, height: 780, max: true });
});
