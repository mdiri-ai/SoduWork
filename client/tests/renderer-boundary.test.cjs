'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { create } = require('../main/renderer-boundary.cjs');
const root = path.resolve(__dirname, '..');
const url = name => pathToFileURL(path.join(root, name)).href;
function harness() {
  const app = new EventEmitter(), raw = new EventEmitter(), handlers = new Map();
  raw.handle = (name, fn) => handlers.set(name, fn);
  const boundary = create({ app, ipcMain: raw, root });
  function sender(page = 'desk.html', preload = path.join(root, 'preload.js')) {
    const wc = new EventEmitter();
    wc.mainFrame = { url: url(page) }; wc.getURL = () => wc.mainFrame.url;
    wc.isDestroyed = () => false; wc.getLastWebPreferences = () => ({ preload });
    wc.setWindowOpenHandler = fn => { wc.open = fn; };
    if (preload === path.join(root, 'preload.js')) boundary.protect(wc);
    return { sender: wc, senderFrame: wc.mainFrame };
  }
  return { ...boundary, raw, handlers, sender };
}

test('desktop, overlay and composer keep the bridge; other frames, windows and origins cannot authorize it', () => {
  const f = harness();
  for (const page of ['desk.html', 'index.html', 'app-composer-launcher.html']) {
    const event = f.sender(page); event.senderFrame.url += '?panel=chatbar#current';
    f.raw.emit('client-preload-trust', event); assert.equal(event.returnValue, true, page);
    const subframe = { ...event, senderFrame: { url: event.senderFrame.url } };
    f.raw.emit('client-preload-trust', subframe); assert.equal(subframe.returnValue, false);
  }
  for (const href of ['https://example.invalid/', 'data:text/html,desk.html', url('generated/desk.html')]) {
    const event = f.sender(); event.senderFrame.url = href;
    f.raw.emit('client-preload-trust', event); assert.equal(event.returnValue, false, href);
  }
  const other = f.sender('desk.html', path.join(root, 'main/app-chrome-preload.cjs'));
  f.raw.emit('client-preload-trust', other); assert.equal(other.returnValue, false);
});

test('default IPC guard covers sensitive invoke and send handlers and preserves listener removal', async () => {
  const f = harness(), event = f.sender(), calls = [];
  for (const channel of ['pi-session-read-output', 'pi-session-send', 'pi-session-history-delete', 'hub-environment-select', 'device-auth-session']) {
    f.ipcMain.handle(channel, (_event, value) => { calls.push(channel); return value; });
    assert.equal(await f.handlers.get(channel)(event, 'allowed'), 'allowed');
    assert.equal((await f.handlers.get(channel)({ ...event, senderFrame: {} })).code, 'UNTRUSTED_RENDERER');
    const remote = f.sender(); remote.senderFrame.url = 'https://example.invalid/';
    assert.equal((await f.handlers.get(channel)(remote)).code, 'UNTRUSTED_RENDERER');
  }
  assert.equal(calls.length, 5);
  let count = 0; const listener = () => count++;
  f.ipcMain.on('open-desk-window', listener);
  f.raw.emit('open-desk-window', { ...event, senderFrame: {} }); assert.equal(count, 0);
  f.raw.emit('open-desk-window', event); assert.equal(count, 1);
  f.ipcMain.removeListener('open-desk-window', listener);
  f.raw.emit('open-desk-window', event); assert.equal(count, 1);
  event.sender.isDestroyed = () => true;
  assert.equal((await f.handlers.get('pi-session-send')(event)).code, 'UNTRUSTED_RENDERER');
});

test('dedicated App bridge keeps its capability checker without gaining other desktop channels', () => {
  const f = harness(), event = f.sender('app-window-chrome.html', path.join(root, 'main/app-chrome-preload.cjs'));
  f.ipcMain.handle('work-preview-chrome-action', () => 'checked by existing owner handler');
  f.ipcMain.handle('work-preview-show', () => 'must not run');
  assert.equal(f.handlers.get('work-preview-chrome-action')(event), 'checked by existing owner handler');
  assert.equal(f.handlers.get('work-preview-chrome-action')({ ...event, senderFrame: {} }).code, 'UNTRUSTED_RENDERER');
  assert.equal(f.handlers.get('work-preview-show')(event).code, 'UNTRUSTED_RENDERER');
});

test('privileged WebContents reject remote/local generated navigation, redirect, new windows and webviews', () => {
  const f = harness(), { sender } = f.sender();
  for (const kind of ['will-navigate', 'will-redirect']) {
    for (const target of ['https://example.invalid/', url('outputs/index.html')]) {
      let denied = false; sender.emit(kind, { preventDefault() { denied = true; } }, target);
      assert.equal(denied, true, kind + ' ' + target);
    }
    let denied = false; sender.emit(kind, { preventDefault() { denied = true; } }, url('desk.html') + '?panel=workspace');
    assert.equal(denied, false);
  }
  let denied = false;
  sender.emit('will-frame-navigate', { url: 'https://example.invalid/', isMainFrame: true, preventDefault() { denied = true; } });
  assert.equal(denied, true);
  assert.deepEqual(sender.open({ url: 'https://example.invalid/' }), { action: 'deny' });
  denied = false; sender.emit('will-attach-webview', { preventDefault() { denied = true; } }); assert.equal(denied, true);
});

test('actual preload exposes nothing unless the main process explicitly trusts its document', () => {
  for (const trusted of [false, undefined, { ok: true }, true]) {
    const exposed = {}, ipcRenderer = new EventEmitter();
    ipcRenderer.sendSync = channel => channel === 'client-preload-trust' ? trusted : {};
    vm.runInNewContext(fs.readFileSync(path.join(root, 'preload.js'), 'utf8'), {
      require: () => ({ ipcRenderer, contextBridge: { exposeInMainWorld(key, value) { exposed[key] = value; } } }),
    });
    assert.equal(typeof exposed.soduWorkAPI, trusted === true ? 'object' : 'undefined');
  }
});
