'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto');
const maker = require('../scripts/create-jiyong-robots.cjs');
const reader = require('../main/plugin-package-reader.cjs');
const contract = require('../main/soduwork-app-bridge-contract.cjs');

// The exported scripts and SDK are real; the DOM and native replies are controlled.
// These checks exercise the page's click handler without starting a model or Electron.
class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.disabled = false;
    this.dataset = {}; this.children = []; this.attributes = new Set();
    this.firstChild = { nodeValue: '' };
  }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items; }
  toggleAttribute(name, enabled) { if (enabled) this.attributes.add(name); else this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function script(body, name) {
  const resource = body.resources.find(item => item.path === name);
  assert.ok(resource, name);
  return Buffer.from(resource.content, 'base64').toString('utf8');
}
async function page(row, { deniedMethod, locale = 'zh-CN' } = {}) {
  const body = reader.readPersonalArchive(fs.readFileSync(row.package));
  const grants = body.ui.contributions[0].source.bridge.capabilities;
  const elements = new Map(), calls = [];
  const buttons = ['run', 'subscribe', 'trial', 'save-source', 'refresh', 'schedule-cancel', 'schedule-confirm'];
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const document = {
    referrer: '', documentElement: { lang: 'zh-CN' },
    getElementById: element, createElement: () => new Element(),
    querySelector: element, querySelectorAll: selector => selector === 'button' ? buttons.map(element) : [],
  };
  const window = {
    crypto: crypto.webcrypto, addEventListener() {},
    soduWorkAppBridge: {
      events: { onTurnSettled() {}, onDataChanged() {} },
      async request(method, params) {
        contract.normalizeRequest({ id: 'robot-click-' + (calls.length + 1), method, params });
        assert.ok(contract.hasCapability(grants, contract.METHOD_CAPABILITY[method]), method);
        calls.push({ method, params });
        if (method === deniedMethod) return { ok: false, reason: 'Controlled host refusal' };
        if (method === 'context.get') return { ok: true, locale };
        if (method === 'settings.get') return { ok: true, values: {}, revision: 0 };
        if (method === 'data.list') return { ok: true, items: [], next: null };
        return { ok: true };
      },
    },
  };
  window.parent = window;
  const location = { origin: 'https://robot-fixture.invalid', href: 'https://robot-fixture.invalid/ui/index.html' };
  const context = vm.createContext({ window, document, location, URL, Uint8Array, setTimeout, clearTimeout });
  for (const name of ['ui/config.js', 'ui/soduwork-app.js', 'ui/app.js']) {
    vm.runInContext(script(body, name), context, { filename: name });
  }
  for (let count = 0; vm.runInContext('busy', context) && count < 100; count++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(vm.runInContext('busy', context), false, 'initialization completed');
  assert.equal(element('status').attributes.has('data-error'), false, element('status').textContent);
  const before = calls.length;
  return { element, calls, before, context, buttons };
}
test('exported robots submit manual runs through their packaged public SDK', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'jiyong-robot-run-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const rows = await maker.create({ out });
  assert.equal(rows.length, maker.characters.length);
  for (const row of rows) await t.test(row.key, async () => {
    const current = await page(row);
    await current.element('run').onclick();
    const sent = current.calls.slice(current.before);
    assert.deepEqual(sent.map(item => item.method), ['composer.expand', 'composer.send']);
    const character = maker.characters.find(item => row.key === 'jiyong-bot-' + item.id);
    assert.equal(sent[1].params.text, character.task, 'send the installed character task');
    assert.match(sent[1].params.requestId, /^[A-Za-z0-9-]+$/);
    assert.equal(current.element('status').attributes.has('data-error'), false);
    assert.match(current.element('status').textContent, /右侧对话/);
    assert.equal(vm.runInContext('busy', current.context), false);
    for (const id of current.buttons) assert.equal(current.element(id).disabled, false);
  });
  await t.test('a rejected composer expansion retains its error and does not send the task', async () => {
    const current = await page(rows[0], { deniedMethod: 'composer.expand', locale: 'en-US' });
    await current.element('run').onclick();
    assert.deepEqual(current.calls.slice(current.before).map(item => item.method), ['composer.expand']);
    assert.equal(current.element('status').textContent, 'Controlled host refusal');
    assert.equal(current.element('status').attributes.has('data-error'), true);
    assert.equal(current.element('run').disabled, false);
    assert.equal(vm.runInContext('busy', current.context), false);
  });
});
