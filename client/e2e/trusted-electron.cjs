'use strict';
// Verify the legacy-fixture migration against the real production trust gate.
const electron = require('./fixtures/trusted-electron.cjs');
if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = require('node:child_process').spawnSync(electron, [__filename], {
    env, windowsHide: true, encoding: 'utf8', timeout: 45000,
  });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, WebContentsView } = electron;
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const assert = require('node:assert/strict');
  const { pathToFileURL } = require('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-e2e-trust-'));
  app.setPath('userData', path.join(root, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const preload = path.resolve(__dirname, '../preload.js');
  const windows = [], checks = [];
  const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks.push(name); };
  const createWindow = selected => {
    const win = new BrowserWindow({ show: false, webPreferences: {
      preload: selected || preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    windows.push(win); return win;
  };
  const timeout = setTimeout(() => finish(Error('Fixture trust timed out')), 30000);
  function finish(error) {
    clearTimeout(timeout);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    console.log(JSON.stringify({ ok: !error, checks, error: error?.stack,
      boundary: 'Real Electron with production boundary and isolated local entries; sandbox:true except the explicit legacy require-wrapper compatibility case.' }));
    app.exit(error ? 1 : 0);
  }
  app.whenReady().then(async () => {
    const first = path.join(root, 'first.html'), second = path.join(root, 'second.html');
    fs.writeFileSync(first, '<!doctype html><p>First fixture</p>');
    fs.writeFileSync(second, '<!doctype html><p>Second fixture</p>');
    const win = createWindow();
    let observedOpens = 0;
    win.webContents.setWindowOpenHandler(() => { observedOpens++; return { action: 'deny' }; });
    await win.loadFile(first);
    check('explicit local fixture receives production bridge', await win.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    let customNavigations = 0;
    win.webContents.on('will-navigate', () => customNavigations++);
    await win.loadFile(second);
    check('second native local load updates exact entry allowlist', await win.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    await win.webContents.executeJavaScript('location.assign("https://example.invalid/")');
    await new Promise(resolve => setTimeout(resolve, 50));
    check('remote renderer navigation remains blocked', win.webContents.getURL(), pathToFileURL(second).href);
    check('existing navigation observers survive registration changes', customNavigations > 0, true);
    await win.webContents.executeJavaScript('window.open("https://example.invalid/")');
    await new Promise(resolve => setTimeout(resolve, 50));
    check('existing denied-window observers survive registration changes', observedOpens, 1);
    await win.loadURL('data:text/html,<p>Untrusted replacement</p>');
    check('later data navigation never inherits the production bridge', await win.webContents.executeJavaScript('typeof soduWorkAPI'), 'undefined');
    const inline = createWindow();
    await inline.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><p>Inline fixture</p>'));
    check('initial inline fixture is an explicit local file', inline.webContents.getURL().startsWith('file:'), true);
    check('initial inline fixture receives the bridge', await inline.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    const copiedPreload = path.join(root, 'preload.js'); fs.copyFileSync(preload, copiedPreload);
    const copied = createWindow(copiedPreload); await copied.loadFile(first);
    check('copied production preload remains compatible', await copied.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    const wrapperPreload = path.join(root, 'wrapper.cjs');
    fs.writeFileSync(wrapperPreload, 'require(' + JSON.stringify(preload.slice(0, -3)) + ');');
    const wrapped = new BrowserWindow({ show: false, webPreferences: {
      preload: wrapperPreload, sandbox: false, contextIsolation: true, nodeIntegration: false,
    } });
    windows.push(wrapped); await wrapped.loadFile(first);
    check('explicit extensionless production preload require is recognized', await wrapped.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    const view = new WebContentsView({ webPreferences: { preload, sandbox: true, contextIsolation: true } });
    win.contentView.addChildView(view); await view.webContents.loadFile(first);
    check('composer WebContentsView is explicitly registered', await view.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    const customPreload = path.join(root, 'untrusted.cjs');
    fs.writeFileSync(customPreload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('isTrusted',ipcRenderer.sendSync('client-preload-trust'));");
    const untrusted = createWindow(customPreload); await untrusted.loadFile(first);
    check('another preload does not acquire the same-file trust', await untrusted.webContents.executeJavaScript('isTrusted'), false);
    const raw = require('electron');
    const outsider = new raw.BrowserWindow({ show: false, webPreferences: { preload: customPreload, sandbox: true, contextIsolation: true } });
    windows.push(outsider); await outsider.loadFile(first);
    check('unregistered native window receives an explicit denial', await outsider.webContents.executeJavaScript('isTrusted'), false);
    const boundary = require('../main/renderer-boundary.cjs').create({ ipcMain: raw.ipcMain, root: path.dirname(preload), pages: [first] });
    const production = new raw.BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    windows.push(production); boundary.protect(production.webContents); await production.loadFile(first);
    check('an independent production boundary retains its own trust reply', await production.webContents.executeJavaScript('typeof soduWorkAPI'), 'object');
    finish();
  }).catch(finish);
}
