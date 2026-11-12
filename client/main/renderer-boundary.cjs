'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const canonical = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const DENIED = Object.freeze({ ok: false, code: 'UNTRUSTED_RENDERER', reason: 'This action requires a SoduWork window' });

// These dedicated surfaces have their own live-view ownership/capability checks.
// They never gain access to the desktop's other IPC channels.
const DELEGATED = new Set(['work-preview-app-request', 'work-preview-chrome-action', 'computer-overlay-ready']);
function mainFrame(event) {
  try {
    const sender = event.sender;
    return !sender.isDestroyed() && !!sender.mainFrame && event.senderFrame === sender.mainFrame &&
      event.senderFrame.url === sender.getURL();
  } catch { return false; }
}

function create({ ipcMain, root, pages = ['desk.html', 'index.html', 'app-composer-launcher.html'].map(name => path.join(root, name)) }) {
  const entries = new Set(pages.map(canonical)), contents = new WeakSet();
  function allowedURL(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'file:' && !url.host && entries.has(canonical(fileURLToPath(url)));
    } catch { return false; }
  }
  function protect(sender) {
    if (contents.has(sender)) return;
    // Called only by the native desktop/overlay/composer constructors, before
    // their first load. A page URL or a renderer message cannot enroll a view.
    contents.add(sender);
    // Renderer navigations (including form submissions and redirects) cannot
    // replace a privileged document with a remote or generated local page.
    const navigate = (event, url) => { if (!allowedURL(url)) event.preventDefault(); };
    sender.on('will-navigate', navigate);
    sender.on('will-redirect', navigate);
    sender.on('will-frame-navigate', (event, details) => {
      const navigation = details || event;
      if (navigation.isMainFrame && !allowedURL(navigation.url)) event.preventDefault();
    });
    sender.on('will-attach-webview', event => event.preventDefault());
    sender.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  function trusted(event) {
    return mainFrame(event) && contents.has(event.sender) && allowedURL(event.senderFrame.url);
  }
  // A sandboxed preload cannot import filesystem helpers. Ask the main process
  // before constructing or exposing the bridge; no page can authorize itself.
  ipcMain.on('client-preload-trust', event => { event.returnValue = trusted(event); });

  const listeners = new Map();
  const accepted = (channel, event) => trusted(event) || (DELEGATED.has(channel) && mainFrame(event));
  const wrap = (channel, callback, sync = false) => function(event, ...args) {
    if (!accepted(channel, event)) {
      if (sync) event.returnValue = DENIED;
      return DENIED;
    }
    return callback.call(this, event, ...args);
  };
  const adapter = new Proxy(ipcMain, { get(target, key) {
    if (key === 'handle' || key === 'handleOnce') return (channel, callback) => target[key](channel, wrap(channel, callback));
    if (key === 'on' || key === 'once' || key === 'addListener') return (channel, callback) => {
      let callbacks = listeners.get(channel);
      if (!callbacks) listeners.set(channel, callbacks = new WeakMap());
      let guarded = callbacks.get(callback);
      if (!guarded) callbacks.set(callback, guarded = wrap(channel, callback, true));
      target[key](channel, guarded);
      return adapter;
    };
    if (key === 'removeListener' || key === 'off') return (channel, callback) => {
      target[key](channel, listeners.get(channel)?.get(callback) || callback);
      return adapter;
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ipcMain: adapter, trusted, protect };
}

module.exports = { create };
