'use strict';
// Real sandboxed Electron, production preload/Markdown/artifact handler, and
// synthetic files only. No running desktop, credentials, Hub or model is used.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const electron = require('electron'), client = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = process.argv[2];
if (!path.isAbsolute(output || '')) throw Error('An absolute isolated evidence directory is required');
fs.mkdirSync(output, { recursive: true });

if (typeof electron === 'string') {
  const env = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'CHROME_CRASHPAD_PIPE_NAME', 'CHROME_CRASHPAD_PIPE_HANDLE']) delete env[key];
  const result = spawnSync(electron, [__filename, output], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  fs.writeFileSync(path.join(output, 'electron.log'), (result.stdout || '') + (result.stderr || '') + (result.error?.message || ''));
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = result.status === 0 && report.ok ? 0 : 1;
} else {
  const { app, BrowserWindow, ipcMain: rawIpc } = electron;
  app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const pages = ['desk.html', 'index.html', 'app-composer-launcher.html'].map(name => path.join(output, name));
  const boundary = require('../main/renderer-boundary.cjs').create({ ipcMain: rawIpc, root: client, pages });
  const { ipcMain } = boundary;
  const workspace = path.join(output, 'workspace'); fs.mkdirSync(workspace, { recursive: true });
  const small = path.join(workspace, 'small.txt'), large = path.join(workspace, 'large.txt');
  fs.writeFileSync(small, 'SODUWORK_SYNTHETIC_你好_😀');
  fs.writeFileSync(large, Buffer.alloc(8 * 1024 * 1024, 65));
  const handle = { ref: 'synthetic-reference', cwd: workspace };
  ipcMain.on('client-distribution-info', event => { event.returnValue = {}; });
  let effects = 0;
  ipcMain.handle('hub-environment-select', () => { effects++; return { ok: true }; });
  ipcMain.on('desk-flags', () => effects++);
  require('../main/pi-session/artifact-ipc.js').install({ app, ipcMain, BrowserWindow,
    session: { get: ref => ref === handle.ref ? handle : null }, workDir: () => workspace });
  const report = { ok: false, checks: [], electron: process.versions.electron, chromiumSandboxDisabled: process.argv.includes('--no-sandbox'),
    boundary: 'Real Electron and production boundary/preload/Markdown/artifact IPC; isolated entry fixtures, synthetic session and files, no production main or user data' };
  const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); report.checks.push({ name, ok: true }); };
  const server = http.createServer((request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: '/landing' }); response.end(); return; }
    response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>Synthetic destination</title><p>Isolated fixture</p>');
  });
  const windows = [];
  const createWindow = (preload = path.join(client, 'preload.js')) => {
    const win = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true,
      nodeIntegration: false, sandbox: true, nodeIntegrationInSubFrames: true, backgroundThrottling: false } });
    if (preload === path.join(client, 'preload.js')) boundary.protect(win.webContents);
    windows.push(win); return win;
  };
  const timeout = setTimeout(() => { report.error = 'Electron fixture timed out'; finish(1); }, 45000);
  function finish(code) {
    clearTimeout(timeout); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    server.close(); app.exit(code);
  }
  app.whenReady().then(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const landing = 'http://127.0.0.1:' + server.address().port + '/landing';
    const scripts = ['vendor/markdown/marked.umd.js', 'vendor/markdown/purify.min.js',
      'components/panels/chat-output-links.js', 'components/panels/chat-markdown.js'];
    for (const file of pages) {
      const source = fs.readFileSync(path.join(client, path.basename(file)), 'utf8');
      const csp = source.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/i)?.[0] || '';
      fs.writeFileSync(file, '<!doctype html><meta charset="utf-8">' + csp + '<main id="content"></main>' +
        scripts.map(script => '<script src="' + pathToFileURL(path.join(client, script)).href + '"></script>').join(''));
    }
    const win = createWindow(), js = source => win.webContents.executeJavaScript(source, true);
    handle.attachedWindow = win;
    await win.loadFile(pages[0]);
    check('trusted desktop keeps production bridge', await js('typeof soduWorkAPI.conversationSession.readOutput'), 'function');
    check('trusted artifact read preserves UTF-8', await js(`soduWorkAPI.conversationSession.readOutput(${JSON.stringify(handle.ref)},${JSON.stringify(small)}).then(v=>v.text)`), fs.readFileSync(small, 'utf8'));
    let bytesRead = 0;
    const open = fs.promises.open;
    fs.promises.open = async function(target, ...args) {
      const file = await open.call(this, target, ...args);
      if (target === large) {
        const read = file.read.bind(file);
        file.read = async (...input) => { const result = await read(...input); bytesRead += result.bytesRead; return result; };
      }
      return file;
    };
    let largeResult;
    try { largeResult = await js(`soduWorkAPI.conversationSession.readOutput(${JSON.stringify(handle.ref)},${JSON.stringify(large)})`); }
    finally { fs.promises.open = open; }
    check('eight MiB preview returns twenty thousand characters', [largeResult.ok, largeResult.tooBig, largeResult.size, largeResult.text.length], [true, true, 8388608, 20000]);
    check('eight MiB preview reads only bounded prefix', bytesRead, 80000);
    const payload = '<form action="' + landing + '"><input name="x"><button formaction="' + landing + '">Continue</button></form>';
    check('production Markdown strips forms and form controls', await js(`document.querySelector('#content').innerHTML=ChatMarkdown.create({_ref:'synthetic-reference',esc:s=>String(s)}).rich(${JSON.stringify(payload)});document.querySelectorAll('form,input,button').length`), 0);
    const original = win.webContents.getURL();
    await js(`{const form=document.createElement('form');form.action=${JSON.stringify(landing)};document.body.append(form);form.submit();}`);
    await wait(120); check('CSP blocks even a directly injected form', win.webContents.getURL(), original);
    await js(`location.assign(${JSON.stringify(landing)})`); await wait(120);
    check('renderer remote navigation is denied', win.webContents.getURL(), original);
    const generated = path.join(workspace, 'generated.html'); fs.writeFileSync(generated, '<p>Generated output</p>');
    await js(`location.assign(${JSON.stringify(pathToFileURL(generated).href)})`); await wait(120);
    check('renderer generated-file navigation is denied', win.webContents.getURL(), original);
    const before = BrowserWindow.getAllWindows().length;
    await js(`window.open(${JSON.stringify(landing)})`); await wait(100);
    check('window.open cannot create a privileged child', BrowserWindow.getAllWindows().length, before);
    await js(`{const frame=document.createElement('iframe');frame.src=${JSON.stringify(pathToFileURL(pages[1]).href)};document.body.append(frame);}`);
    await wait(250);
    const child = win.webContents.mainFrame.frames[0];
    check('subframe never receives the bridge', await child.executeJavaScript('typeof soduWorkAPI'), 'undefined');
    let redirects = 0; win.webContents.on('will-redirect', () => redirects++);
    await win.loadURL(landing.replace('/landing', '/redirect')).catch(() => {}); await wait(100);
    check('server redirects are denied', redirects > 0 && !win.webContents.getURL().endsWith('/landing'), true);
    // Main-process loadURL is intentionally outside will-navigate. Even that
    // transition must not expose the bridge on the resulting remote document.
    await win.loadURL(landing);
    check('remote document has no inherited preload bridge', await js('typeof soduWorkAPI'), 'undefined');
    for (const file of pages.slice(1)) {
      await win.loadFile(file);
      check(path.basename(file) + ' remains trusted', await js('typeof soduWorkAPI'), 'object');
    }
    const attackPreload = path.join(output, 'attacker-preload.cjs');
    fs.writeFileSync(attackPreload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('probe',{read:()=>ipcRenderer.invoke('pi-session-read-output',${JSON.stringify(handle.ref)},${JSON.stringify(small)}),select:()=>ipcRenderer.invoke('hub-environment-select','synthetic'),send:()=>ipcRenderer.send('desk-flags',{})});`);
    const attacker = createWindow(attackPreload); await attacker.loadURL(landing);
    const denied = await attacker.webContents.executeJavaScript('(async()=>{probe.send();return [(await probe.read()).code,(await probe.select()).code]})()');
    check('actual artifact and environment IPC reject a foreign WebContents', denied, ['UNTRUSTED_RENDERER', 'UNTRUSTED_RENDERER']);
    await wait(50); check('unauthorized send/invoke causes no side effects', effects, 0);
    check('Chromium sandbox stays enabled', report.chromiumSandboxDisabled, false);
    report.ok = true; finish(0);
  }).catch(error => { report.error = error.stack; finish(1); });
}
