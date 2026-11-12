'use strict';

// Test-only compatibility layer for fixtures that load the production preload.
// Native constructor options select the preload; native loadFile calls identify
// the exact local fixture. Remote documents and subframes never gain the bridge.
// Business IPC handlers remain the production handlers/mocks installed by each
// fixture. The dedicated renderer-boundary E2E verifies their production adapter.
const electron = require('electron');
if (typeof electron === 'string') {
  module.exports = electron;
} else {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { fileURLToPath } = require('node:url');
  const { createRequire } = require('node:module');
  const { create } = require('../../main/renderer-boundary.cjs');
  const root = path.resolve(__dirname, '../..');
  const productionPreload = path.join(root, 'preload.js');
  const productionSource = fs.readFileSync(productionPreload, 'utf8');
  const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const states = new WeakMap();
  const navigationEvents = ['will-navigate', 'will-redirect', 'will-frame-navigate', 'will-attach-webview'];
  let inlineRoot, nextInline = 0;

  function usesProductionPreload(value) {
    if (!value) return false;
    if (canonical(value) === canonical(productionPreload)) return true;
    // Some fixtures copy the real preload beside an isolated index.html, or
    // require it from a small instrumentation preload. These remain native,
    // explicitly selected test files, never renderer-provided preload paths.
    try {
      const source = fs.readFileSync(value, 'utf8');
      if (source.includes(productionSource)) return true;
      const resolver = createRequire(path.resolve(value));
      for (const match of source.matchAll(/require\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/g)) {
        try {
          const literal = match[1];
          const request = JSON.parse(literal.startsWith('"') ? literal :
            '"' + literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"');
          if (canonical(resolver.resolve(request)) === canonical(productionPreload)) return true;
        } catch { /* A non-file or dynamic require does not enroll a fixture. */ }
      }
      return false;
    } catch { return false; }
  }

  electron.ipcMain.on('client-preload-trust', event => {
    const state = states.get(event.sender);
    // A fixture that launches real main.js owns its own production listener.
    // Never reply for WebContents not constructed through this test helper.
    if (state?.trust) state.trust(event);
    else if (electron.ipcMain.listenerCount('client-preload-trust') === 1) event.returnValue = false;
  });

  function cleanup() {
    if (!inlineRoot) return;
    const owned = path.resolve(inlineRoot), temporary = path.resolve(os.tmpdir()) + path.sep;
    if (!owned.startsWith(temporary) || !path.basename(owned).startsWith('soduwork-e2e-entry-')) {
      throw Error('Refusing cleanup outside the helper-owned temporary directory');
    }
    fs.rmSync(owned, { recursive: true, force: true }); inlineRoot = undefined;
  }
  electron.app.on('will-quit', cleanup);
  process.once('exit', cleanup);

  function inlineFixture(value) {
    let html;
    if (value === 'about:blank') html = '<!doctype html><meta charset="utf-8">';
    else {
      const match = /^data:text\/html(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(value);
      if (!match) return null;
      html = match[1] ? Buffer.from(match[2], 'base64').toString('utf8') : decodeURIComponent(match[2]);
    }
    inlineRoot ||= fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-e2e-entry-'));
    const file = path.join(inlineRoot, 'entry-' + (++nextInline) + '.html');
    fs.writeFileSync(file, html);
    return file;
  }

  function enroll(contents) {
    if (states.has(contents)) return;
    const state = { pages: new Set(), listeners: [], trust: event => { event.returnValue = false; }, loaded: false };
    states.set(contents, state);
    // Each WebContents has its own production boundary. Route only its trust
    // reply, and replace its own navigation listeners when a native fixture
    // load adds another page. Other fixtures' listeners remain untouched.
    const trustIPC = { on(channel, callback) {
      if (channel !== 'client-preload-trust') throw Error('Unexpected boundary registration: ' + channel);
      state.trust = callback;
    } };
    const setWindowOpenHandler = contents.setWindowOpenHandler.bind(contents);
    let fixtureOpenHandler, registering = false;
    contents.setWindowOpenHandler = handler => {
      if (!registering) fixtureOpenHandler = handler;
      return setWindowOpenHandler(handler);
    };
    function allow(file) {
      const resolved = path.resolve(file);
      if (state.pages.has(resolved)) return;
      state.pages.add(resolved);
      for (const [name, listener] of state.listeners) contents.removeListener(name, listener);
      state.listeners = [];
      const before = new Map(navigationEvents.map(name => [name, new Set(contents.listeners(name))]));
      const boundary = create({ ipcMain: trustIPC, root, pages: [...state.pages] });
      registering = true;
      try { boundary.protect(contents); }
      finally { registering = false; }
      // A fixture may observe denied opens to assert its own link behavior.
      // Preserve that observation without authorizing a new child window.
      if (fixtureOpenHandler) setWindowOpenHandler(details => {
        fixtureOpenHandler(details); return { action: 'deny' };
      });
      for (const name of navigationEvents) {
        for (const listener of contents.listeners(name)) {
          if (!before.get(name).has(listener)) state.listeners.push([name, listener]);
        }
      }
    }
    const loadFile = contents.loadFile.bind(contents), loadURL = contents.loadURL.bind(contents);
    contents.loadFile = (file, options) => {
      allow(file); state.loaded = true;
      return loadFile(file, options);
    };
    contents.loadURL = (value, options) => {
      let file;
      try { if (new URL(value).protocol === 'file:') file = fileURLToPath(value); } catch {}
      if (file) { allow(file); state.loaded = true; }
      else if (!state.loaded) {
        // Old fixtures used an initial data URL as their empty host. Materialize
        // it as an explicit local fixture; subsequent navigation stays untrusted.
        file = inlineFixture(value);
        if (file) { allow(file); state.loaded = true; return loadFile(file); }
      }
      state.loaded = true;
      return loadURL(value, options);
    };
    contents.once('destroyed', () => states.delete(contents));
  }

  function constructor(Type) {
    return new Proxy(Type, { construct(target, args) {
      const instance = Reflect.construct(target, args);
      if (usesProductionPreload(args[0]?.webPreferences?.preload)) enroll(instance.webContents);
      else states.set(instance.webContents, { trust: event => { event.returnValue = false; } });
      return instance;
    } });
  }
  // Do not mutate Electron's module exports: production helpers that own narrow
  // screenshot/consent windows continue to use their independent authority.
  module.exports = { ...electron, BrowserWindow: constructor(electron.BrowserWindow),
    WebContentsView: constructor(electron.WebContentsView) };
}
