'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { expectedReply, createConversation } = require('../planning-online-session.cjs');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const state = process.env.PLANNING_QA_STATE;
const output = process.env.PLANNING_QA_OUTPUT;
const client = path.join(state, 'application', 'client');
const scratch = process.env.PLANNING_QA_SCRATCH;
const workspace = path.join(scratch, 'workspace');
const data = path.join(scratch, 'runner-data');
const profile = path.join(scratch, 'profile');
for (const dir of [workspace, data, profile]) fs.mkdirSync(dir);
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.disableHardwareAcceleration();

const scope = { hub: 'http://127.0.0.1:1', owner: 'test-owner', clientId: 'test-device' };
const prefix = '@@SODUWORK_LOCAL_RPC@@';
const pending = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let runner, win, conversation, planningHost;
let closing = false, sequence = 0;
const log = text => {
  fs.appendFileSync(path.join(output, 'progress.log'), new Date().toISOString() + ' ' + text + '\n');
  console.log(text);
};

function failPending(error) {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}

function startRunner() {
  const windows = process.platform === 'win32';
  const python = path.join(state, 'venv', windows ? 'Scripts' : 'bin', windows ? 'python.exe' : 'python');
  const backend = path.join(state, 'application', 'hub-backend', 'runner_main.py');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|HOME|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|TMPDIR|TMP|TEMP|LANG|LC_ALL|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|REQUESTS_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR|SODUWORK_PLANNING_(INDEX|PUBLIC_INDEX)_URL)$/i.test(key)));
  Object.assign(env, {
    SODUWORK_DATA_ROOT: data, SODUWORK_SOURCE_SESSION: '1', SODUWORK_SOURCE_RUNNER_PYTHON: python,
    SODUWORK_RUNNER_HUB: scope.hub, ADMIN_PASS: randomBytes(24).toString('hex'),
    AUTH_SECRET: randomBytes(32).toString('hex'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
  });
  runner = spawn(python, ['-B', '-u', backend, '--config-stdin'], {
    cwd: scratch, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  runner.stderr.resume();
  runner.stdin.on('error', failPending);
  runner.on('error', failPending);
  runner.on('exit', code => failPending(Error('Test Runner exited: ' + code)));
  readline.createInterface({ input: runner.stdout }).on('line', line => {
    if (!line.startsWith(prefix)) return;
    const packet = JSON.parse(line.slice(prefix.length));
    if (packet.kind === 'planning-host') {
      Promise.resolve().then(() => planningHost(packet.body))
        .catch(error => ({ ok: false, error: error.message }))
        .then(result => runtime.rpc('planning.host.reply', { requestId: packet.id, result }))
        .catch(failPending);
      return;
    }
    const job = pending.get(packet.id);
    if (!job) return;
    pending.delete(packet.id);
    clearTimeout(job.timer);
    if (!packet.ok) job.reject(Error('Runner RPC failed: ' + job.op + ' (' + (packet.error || 'unknown error') + ')'));
    else job.resolve(packet.result);
  });
  runner.stdin.write('@@SODUWORK_RUNNER_CONFIG@@' + JSON.stringify({
    hub: scope.hub, runnerId: 'qa-planning-desktop', clientId: scope.clientId, secret: randomBytes(16).toString('hex'),
    workRoot: workspace, dataRoot: data, customAgents: [],
  }) + '\n');
}

const runtime = {
  onPlanningHost(handler) { planningHost = handler; },
  ready: async () => true, getStatus: () => ({ connected: true, running: true }),
  isRunning: () => runner?.exitCode === null, start: async () => ({ ok: true, running: true }),
  rpc(op, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!runner || runner.exitCode !== null) return reject(Error('Runner unavailable: ' + op));
      const id = String(++sequence);
      const timer = setTimeout(() => { pending.delete(id); reject(Error('RPC timeout: ' + op)); }, timeout);
      pending.set(id, { op, reject, resolve, timer });
      runner.stdin.write(prefix + JSON.stringify({ id, message: { op, ...params } }) + '\n');
    });
  },
};

const js = expr => win.webContents.executeJavaScript(expr, true);
async function wait(expr, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await js(expr);
    if (value) return value;
    await sleep(320);
  }
  throw Error('Timed out in renderer: ' + expr);
}
async function click(selector) {
  const point = await wait(`(() => {
    for (const target of document.querySelectorAll(${JSON.stringify(selector)})) {
      if (target.disabled || !target.checkVisibility({opacityProperty: true, visibilityProperty: true})) continue;
      target.scrollIntoView({ block: 'nearest' });
      const box = target.getBoundingClientRect();
      const x = Math.floor(box.x + box.width / 2), y = Math.floor(box.y + box.height / 2);
      if (target.contains(document.elementFromPoint(x, y))) return { x, y };
    }
    return null;
  })()`);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
}
async function capture(name) {
  const frame = await win.webContents.capturePage();
  fs.writeFileSync(path.join(output, name + '.png'), frame.toPNG());
}

// The Agent drawer also re-probes as a management job finishes. The local
// Runner explicitly returns a retryable BUSY receipt for concurrent probes.
async function detectPlanning(stage) {
  const until = Date.now() + 15000;
  let reply;
  do {
    reply = await runtime.rpc('runtime.detect', { key: 'ai-planning' });
    if (reply.ok) return reply.data;
    if (reply.code !== 'RUNNER_RPC_BUSY' || !reply.retryable) break;
    await sleep(250);
  } while (Date.now() < until);
  throw Error(stage + ' detection failed: ' + (reply.code || '') + ' ' + (reply.error || 'unknown response'));
}

async function management() {
  require(path.join(client, 'main/agent-runtime/planning-management.cjs')).install({ ipcMain, runner: runtime, scopeOf: () => scope });
  const { runtime: runtimeSpec } = require(path.join(client, 'main/agent-runtime/runtime-catalog.js'));
  const { createPiSessionBridge } = require(path.join(client, 'main/agent-runtime/pi-session-bridge.js'));
  const { createRunnerRuntimeAdapter } = require(path.join(client, 'main/agent-runtime/runner-adapter.js'));
  const adapter = createRunnerRuntimeAdapter({ app, runnerRuntime: runtime, runtimeSpec: runtimeSpec('ai-planning') });
  const bridge = createPiSessionBridge({ app, sessionModule: { open() {}, probe: async () => ({ ok: true }) }, runnerAdapters: [adapter] });
  conversation = await createConversation({
    app, client, runtime, workspace, scope, data, adapter, bridge,
  });
  startRunner();
  const detected = await detectPlanning('Initial');
  assert.equal(detected.installed, false, 'An isolated workspace must begin without Planning');
  ipcMain.handle('qa-device-auth', () => ({
    ok: true, stored: true, clientId: scope.clientId, user: { id: scope.owner }, session: scope.session, expiresIn: 1800,
  }));
  ipcMain.handle('qa-first-turn', (_, text, options) => conversation.send(options.adapterId, text, options));
  ipcMain.handle('qa-runtimes', () => bridge.availableRuntimes(app, { force: true }));
  ipcMain.handle('qa-probe', (_, id) => id === 'pi' ? { ok: true } : adapter.detect({ app }));

  win = new BrowserWindow({ width: 1150, height: 830, show: true,
    webPreferences: {
      preload: path.join(__dirname, 'planning-online-preload.cjs'), contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.session.webRequest.onBeforeRequest((req, done) => done({
    cancel: req.resourceType === 'script' || !/^(file|data):/.test(req.url),
  }));
  await win.loadFile(path.join(client, 'desk.html'));
  await js(`localStorage.setItem('soduwork_work_hub_url', ${JSON.stringify(scope.hub)})`);
  const script = file => js(fs.readFileSync(file, 'utf8') + '\nvoid 0;');
  await script(path.join(__dirname, 'planning-online-renderer.js'));
  for (const name of ['core/api-work-plugins.js', 'api.js', 'components/panels/panels-agents.js',
    'components/panels/work-composer.js', 'components/panels/agent-brand.js', 'components/panels/panels-compose-runtime.js',
    'components/panels/panels-compose-capabilities.js', 'components/panels/compose-surface.js',
    'components/panels/panels-compose-work-actions.js', 'components/panels/panels-compose.js']) {
    await script(path.join(client, name));
  }
  await js('SoduWorkAPI.registerClient().then(() => null)');
  const key = 'synthetic-desktop~ai-planning';
  const attr = name => '[' + name + '=' + JSON.stringify(key) + ']';
  const openManager = async () => {
    await js("if (document.querySelector('#composePanel.show')) closeComposePanel(); openAgentsPanel()");
    await click(attr('data-atoggle'));
  };
  const closeManager = async () => {
    await click('[data-adrawer-x]');
    await js('closeAgentsPanel()');
  };
  await openManager();
  await capture('missing');
  await closeManager();
  await js('openComposePanel({ newSession: true })');
  const job = async (action, timeout) => {
    const row = await wait(`(() => { const j = _agJobs[${JSON.stringify(key)}]; return j?.action === ${JSON.stringify(action)} && j.state === 'done' ? {ok:j.ok, detail:j.detail} : null })()`, timeout);
    log(action + ': ' + row.detail); assert.equal(row.ok, true, action + ' failed: ' + row.detail);
    return row;
  };
  const choice = async expected => {
    await click('#cpRuntime');
    await wait("ComposeRuntime.catalog().some(row => row.id === 'ai-planning') === " + expected);
  };
  await choice(false);
  assert.equal(await js('ComposeRuntime.value()'), 'pi');
  await openManager();
  await click(attr('data-ainstall')); await job('install', 1200000);
  const installed = await detectPlanning('Post-install');
  assert.equal(installed.installed, true, 'Installed Planning is missing from the runtime inventory');
  assert.ok(installed.version);
  await click(attr('data-acheck'));
  const check = await job('check', 180000);
  assert.ok(check.detail.includes(installed.version));
  await closeManager();
  await js('openComposePanel({ resumeComposer: true })');
  await choice(true);
  assert.equal(await js('ComposeRuntime.value()'), 'pi');
  await wait("document.querySelector('#cpRuntimePop.show [data-runtime=ai-planning]')?.checkVisibility()");
  await capture('available');
  await click('[data-runtime="ai-planning"]');
  await wait("ComposeRuntime.value() === 'ai-planning'");
  log('Selected Planning in the native chooser, installed version ' + installed.version);
  await click('#cpInput');
  await js(`const input = document.querySelector('#cpInput');
    input.value = 'Send one response from this Planning conversation.';
    input.dispatchEvent(new Event('input', { bubbles: true }));`);

  await capture('installed');
  await click('#cpGo');
  await wait("['answered', 'failed'].includes(document.querySelector('#first-reply')?.dataset.state)", 180000);
  const answer = await js("document.querySelector('#first-reply').textContent");
  assert.equal(answer, expectedReply);
  log('First assistant reply after explicit Planning selection: ' + answer);
  await capture('first-turn');
  await openManager();
  await click(attr('data-aupdate')); await job('update', 1200000);
  const updated = await detectPlanning('Post-update');
  assert.equal(updated.installed, true, 'Updated Planning is missing from the runtime inventory');
  assert.ok(updated.version);
  log('Enterprise update ' + installed.version + ' -> ' + updated.version);
  await capture('updated');
  await click(attr('data-aunin')); await click(attr('data-adoun')); await job('uninstall', 90000);
  const removed = await detectPlanning('Post-uninstall');
  assert.equal(removed.installed, false, 'Removed Planning is still reported as installed');
  await capture('uninstalled');
  await closeManager();
  await js('openComposePanel({ newSession: true })');
  await choice(false);
}

async function closeTest(code) {
  if (closing) return;
  closing = true;
  if (conversation) {
    try { await conversation.close(); }
    catch (error) { log('Conversation cleanup failed: ' + error.message); code = 1; }
  }
  if (win && !win.isDestroyed()) win.destroy();
  if (runner?.pid && runner.exitCode === null && runner.signalCode === null) {
    const stopped = new Promise(resolve => runner.once('close', resolve));
    runner.stdin.end();
    await Promise.race([stopped, sleep(2500)]);
    if (runner.exitCode === null && runner.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolve => execFile('taskkill', ['/PID', String(runner.pid), '/T', '/F'], { windowsHide: true }, resolve));
      } else runner.kill('SIGKILL');
      await Promise.race([stopped, sleep(2500)]);
    }
  }
  app.exit(code);
}

app.on('window-all-closed', () => {});
app.on('before-quit', event => { if (!closing) { event.preventDefault(); void closeTest(1); } });
app.whenReady().then(async () => {
  log('Platform ' + process.platform + '; synthetic identity, Hub inventory, resident Pi and model response. Production Agent management, chooser, session bridge, Runner, ACP and online package install.');
  await management();
  log('PASS: install, version detection, unchanged initial Pi, explicit Planning selection, first assistant reply, update, uninstall and refreshed chooser.');
  await closeTest(0);
}).catch(async error => {
  log('FAIL: ' + error.message);
  if (win && !win.isDestroyed()) await capture('failure').catch(() => {});
  await closeTest(1);
});
