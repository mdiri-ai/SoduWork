'use strict';
/* Issue #495 (方案二): settings UI for the member repository → local path mapping. */
const test = require('node:test'), assert = require('node:assert/strict');
const path = require('node:path'), fs = require('node:fs'), vm = require('node:vm');

const CORE = path.join(__dirname, '../core/');
const LOCALES = path.join(CORE, 'locales/');
const SETTINGS = path.join(__dirname, '../components/settings/');
const LOCALE_FILES = JSON.parse(fs.readFileSync(path.join(LOCALES, 'manifest.json'), 'utf8'))
  .filter(name => /^(en|ja|ko)-/.test(name));

const REPO_IDS = new Set(['repoPathSettings', 'repoPathUrlInput', 'repoPathDirInput',
  'repoPathPick', 'repoPathSave', 'repoPathList', 'repoPathNote']);
const BASE_IDS = new Set(['clientUpdateBadge', 'clientUpdateDot', 'clientUpdateTitle',
  'clientUpdateDetail', 'clientUpdateAction', 'clientUpdateBlockers', 'settingsPanel',
  'remindSeg', 'scaleSeg', 'fontSeg', 'localeSelect', 'workRootInput', 'workRootSave',
  'workRootNote', 'boxNameInput', 'boxNameSave', 'boxBindNote', 'skinOpenBtn',
  'skinCurName', 'petVisibleChk', 'dockVisibleChk', 'trayVisibleChk', 'trayOffNote',
  'settingsClose', 'pet']);

function stubElement(tag) {
  const listeners = {}, children = [], attrs = {};
  return {
    nodeType: 1, tagName: String(tag || 'div').toUpperCase(), children, attrs, listeners,
    textContent: '', title: '', hidden: false, disabled: false, checked: false,
    value: '', className: '', innerHTML: '', scrollTop: 0, style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener() {},
    fire(type, event = {}) {
      for (const fn of listeners[type] || []) fn(Object.assign({ target: this, preventDefault() {} }, event));
    },
    querySelector: () => null, querySelectorAll: () => [],
    setAttribute(name, value) { attrs[name] = value; },
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
    hasAttribute(name) { return Object.hasOwn(attrs, name); },
    removeAttribute(name) { delete attrs[name]; },
    replaceChildren(...nodes) { children.length = 0; children.push(...nodes); },
    append(...nodes) { children.push(...nodes); },
    appendChild(node) { children.push(node); },
    focus() {}, matches: () => false, scrollIntoView() {},
    closest(selector) {
      return selector === '.set-repo-path-remove' && String(this.className).includes('set-repo-path-remove') ? this : null;
    },
  };
}

function boot() {
  const saved = [], deleted = [], picked = [];
  const elements = new Map();
  const sandbox = {
    console, setTimeout, clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: {
      documentElement: { lang: '', dataset: {}, style: { setProperty() {} } },
      readyState: 'complete', body: null, title: '',
      createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
      addEventListener() {}, removeEventListener() {},
      querySelector: () => null, querySelectorAll: () => [],
      createElement: tag => stubElement(tag),
      getElementById(id) {
        if (!REPO_IDS.has(id) && !BASE_IDS.has(id)) return null;
        if (!elements.has(id)) elements.set(id, stubElement());
        return elements.get(id);
      },
    },
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    cfg: { uiScale: 'medium', fontScale: 'medium', petVisible: true, dockVisible: true, trayVisible: true },
    saveCfg() {}, petSay() {}, Store: {}, User: { id: 'u-1', name: 'tester' },
    soduWorkAPI: {
      clientUpdateStatus: async () => ({ state: 'current', currentVersion: '1.12.79' }),
      onClientUpdateStatus: () => {}, getDefaultWorkRoot: async () => 'C:\\Users\\t\\SoduWork',
      setLocale: () => {},
      clientRepoPaths: async () => [{ gitUrl: 'https://github.com/Org/App', localPath: 'D:/work/app' }],
      saveClientRepoPath: async (gitUrl, localPath) => { saved.push({ gitUrl, localPath }); return []; },
      deleteClientRepoPath: async gitUrl => { deleted.push(gitUrl); return []; },
      conversationSession: {
        pickWorkdir: async options => { picked.push(options); return { ok: true, dir: 'D:/picked/app' }; },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  const run = (file, base) => vm.runInContext(
    fs.readFileSync(path.join(base, file), 'utf8'), sandbox, { filename: file });
  run('locale-registry.js', LOCALES);
  for (const file of LOCALE_FILES) run(file, LOCALES);
  run('i18n-dom.js', CORE);
  run('i18n.js', CORE);
  run('client-update-view.js', SETTINGS);
  run('settings.js', SETTINGS);
  return { sandbox, saved, deleted, picked };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('settings markup exposes each repository mapping control exactly once', () => {
  const html = fs.readFileSync(path.join(__dirname, '../desk.html'), 'utf8');
  for (const id of REPO_IDS) assert.equal(html.split('id="' + id + '"').length - 1, 1, id);
});

test('opening settings loads and renders the member repository mapping list', async () => {
  const f = boot();
  await sleep(0);
  const list = f.sandbox.document.getElementById('repoPathList');
  assert.equal(list.children.length, 1);
  const row = list.children[0];
  assert.equal(row.className, 'set-repo-path-row');
  assert.equal(row.children[0].textContent, 'https://github.com/Org/App');
  assert.equal(row.children[1].textContent, 'D:/work/app');
  assert.equal(row.children[2].getAttribute('data-git-url'), 'https://github.com/Org/App');
});

test('the save flow picks a local directory and posts the entered git URL', async () => {
  const f = boot();
  await sleep(0);
  const url = f.sandbox.document.getElementById('repoPathUrlInput');
  const dir = f.sandbox.document.getElementById('repoPathDirInput');
  f.sandbox.document.getElementById('repoPathPick').fire('click');
  await sleep(0);
  assert.equal(dir.value, 'D:/picked/app');
  assert.equal(f.picked.length, 1);
  url.value = 'https://github.com/Org/App.git';
  f.sandbox.document.getElementById('repoPathSave').fire('click');
  await sleep(0);
  assert.deepEqual(f.saved, [{ gitUrl: 'https://github.com/Org/App.git', localPath: 'D:/picked/app' }]);
  assert.equal(url.value, '');
  assert.equal(dir.value, '');
});

test('the remove button deletes the mapping shown on its row', async () => {
  const f = boot();
  await sleep(0);
  const list = f.sandbox.document.getElementById('repoPathList');
  list.fire('click', { target: list.children[0].children[2] });
  await sleep(0);
  assert.deepEqual(f.deleted, ['https://github.com/Org/App']);
});
