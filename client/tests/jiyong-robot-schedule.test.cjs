'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto');
const maker = require('../scripts/create-jiyong-robots.cjs');
const reader = require('../main/plugin-package-reader.cjs');
const personal = require('../main/personal-plugins');
const store = require('../main/app-settings-store.cjs');
const connection = require('../main/work-preview-app-connection.cjs');
const automation = require('../main/work-preview-app-automation.cjs');
const contract = require('../main/soduwork-app-bridge-contract.cjs');

class Element {
  constructor() {
    this.value = ''; this.textContent = ''; this.disabled = false;
    this.children = []; this.attributes = new Set(); this.firstChild = { nodeValue: '' };
  }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items; }
  toggleAttribute(name, enabled) { if (enabled) this.attributes.add(name); else this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function resource(body, name) {
  const item = body.resources.find(row => row.path === name);
  assert.ok(item, name);
  return Buffer.from(item.content, 'base64').toString('utf8');
}
async function idle(context) {
  for (let n = 0; vm.runInContext('busy', context) && n < 200; n++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(vm.runInContext('busy', context), false, 'page action completed');
}
// Exported page/SDK, native request deduplication, installation checks and encrypted
// settings are real. The DOM and schedule business replies are controlled.
async function page(t, row, options = {}) {
  const body = reader.readPersonalArchive(fs.readFileSync(row.package));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-schedule-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = { getPath: () => root }, encryptionKey = crypto.randomBytes(32);
  let account = 'robot-schedule/account-a';
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString();
    },
  };
  store.configure({ app, safeStorage, ownerOf: () => account });
  const installed = personal.create(app, body).plugin;
  const binding = { pluginId: installed.pluginId, origin: require('../core/plugin-package-page.cjs').origin(installed.pluginId) };
  const calls = [], envelopes = [], schedules = [], faults = {};
  const composer = {
    id: 202, isDestroyed: () => false,
    send(channel, envelope) {
      assert.equal(channel, 'app-composer-automation');
      envelopes.push(envelope);
      let result;
      if (options.rejectFirst && envelopes.length === 1) {
        result = { ok: false, reason: 'Controlled preflight refusal' };
      } else {
        const schedule = { id: 'schedule-' + (schedules.length + 1), title: installed.name };
        schedules.push(schedule);
        result = options.uncertain ? { ok: false, uncertain: true, reason: 'Inspect SoduWork Automations before resubmitting' }
          : { ok: true, state: 'created', schedule };
      }
      queueMicrotask(() => automation.finish(composer, { id: envelope.id, result }));
    },
  };
  const owner = { sender: { id: 101, isDestroyed: () => false, send: () => assert.fail('use the app composer') } };
  const item = { id: 'robot-app', appBridge: { appId: 'plugin:' + installed.pluginId, contributionId: 'main', origin: binding.origin },
    composer: { view: { webContents: composer } } };
  require('../main/work-preview-app-owner.cjs').capture(item, { app });
  const elements = new Map(), element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const buttons = [...resource(body, 'ui/index.html').matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
  const document = { referrer: '', documentElement: { lang: 'zh-CN' }, getElementById: element,
    createElement: () => new Element(), querySelector: element,
    querySelectorAll: selector => selector === 'button' ? buttons.map(element) : [] };
  let createCalls = 0;
  const window = { crypto: crypto.webcrypto, addEventListener() {}, soduWorkAppBridge: {
    events: { onTurnSettled() {}, onDataChanged() {} },
    async request(method, params) {
      const request = contract.normalizeRequest({ id: 'robot-request-' + (calls.length + 1), method, params });
      assert.ok(contract.hasCapability(body.ui.contributions[0].source.bridge.capabilities, contract.METHOD_CAPABILITY[method]), method);
      calls.push({ method, params });
      if (method === 'context.get') return { ok: true, locale: options.locale || 'zh-CN' };
      if (method === 'data.list') return { ok: true, items: [], next: null };
      if (method.startsWith('settings.')) {
        if (method === 'settings.update' && faults.save) {
          faults.save = false;
          throw Error('Controlled settings write failure');
        }
        if (method === 'settings.update' && faults.conflict) {
          faults.conflict = false;
          store.update(binding, { values: { fixturePreference: 'changed by the host' } });
        }
        return connection.settings({ item }, request, { app });
      }
      assert.equal(method, 'automation.create');
      createCalls++;
      const result = await automation.submit({ owner, item, request, deps: { app } });
      if (options.loseFirstReply && createCalls === 1) {
        if (options.loseFirstReply === 'bridge-error') return { ok: false, code: 'APP_BRIDGE_ERROR', reason: 'Controlled lost creation reply' };
        throw Error('Controlled lost creation reply');
      }
      return result;
    },
  } };
  window.parent = window;
  const location = { origin: binding.origin, href: binding.origin + '/ui/index.html' };
  const context = vm.createContext({ window, document, location, URL, Uint8Array, setTimeout, clearTimeout });
  for (const name of ['ui/config.js', 'ui/soduwork-app.js', 'ui/app.js']) vm.runInContext(resource(body, name), context, { filename: name });
  await idle(context);
  assert.equal(element('status').attributes.has('data-error'), false, element('status').textContent);
  return { element, calls, envelopes, schedules, faults, context, binding, setAccount: value => { account = value; },
    subscribe: async () => { await element('subscribe').onclick(); await idle(context); },
    once: async value => {
      element('schedule-time').value = value;
      element('schedule-form').onsubmit({ preventDefault() {} });
      await idle(context);
    } };
}
function futureInput(minutes = 60) {
  const due = new Date(Date.now() + minutes * 60000);
  due.setMinutes(due.getMinutes() - due.getTimezoneOffset());
  return due.toISOString().slice(0, 16);
}
test('generated robot schedule retries preserve the original creation attempt', async t => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-schedule-packages-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const rows = await maker.create({ out });
  for (const row of rows) await t.test(row.key + ': uncertain subscription does not create twice', async t => {
    const f = await page(t, row, { uncertain: true });
    await f.subscribe(); await f.subscribe();
    assert.equal(f.schedules.length, 1, 'retry must not create another daily schedule');
    const calls = f.calls.filter(item => item.method === 'automation.create');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].params, calls[0].params, 'retry keeps the same text, context and request ID');
    assert.equal(f.element('status').attributes.has('data-error'), true);
    assert.equal(store.get(f.binding).values.scheduleId, undefined);
  });
  await t.test('a lost successful creation reply retries the native receipt and saves its original ID', async t => {
    const f = await page(t, rows[0], { loseFirstReply: true, locale: 'en-US' });
    await f.subscribe();
    assert.equal(f.element('status').textContent, 'Controlled lost creation reply');
    await f.subscribe();
    assert.equal(f.schedules.length, 1);
    assert.equal(store.get(f.binding).values.scheduleId, f.schedules[0].id);
    assert.equal(f.element('status').attributes.has('data-error'), false);
  });
  await t.test('a generic native bridge error retains the original request for receipt recovery', async t => {
    const f = await page(t, rows[0], { loseFirstReply: 'bridge-error' });
    await f.subscribe();
    assert.equal(f.element('status').attributes.has('data-error'), true);
    await f.subscribe();
    assert.equal(f.schedules.length, 1);
    assert.equal(store.get(f.binding).values.scheduleId, f.schedules[0].id);
    const calls = f.calls.filter(item => item.method === 'automation.create');
    assert.deepEqual(calls[1].params, calls[0].params);
  });
  for (const failure of ['save', 'conflict']) await t.test('saved subscription retries a ' + failure + ' without submitting again', async t => {
    const f = await page(t, rows[0]); f.faults[failure] = true;
    await f.subscribe();
    assert.equal(f.element('status').attributes.has('data-error'), true);
    await f.subscribe();
    assert.equal(f.schedules.length, 1);
    assert.equal(f.calls.filter(item => item.method === 'automation.create').length, 1, 'retry only saves the known receipt');
    assert.equal(store.get(f.binding).values.scheduleId, f.schedules[0].id);
    const writes = f.calls.filter(item => item.method === 'settings.update');
    assert.equal(writes.length, 2);
    assert.equal(writes[1].params.expectedRevision, failure === 'conflict' ? 1 : 0);
    await f.subscribe();
    assert.equal(f.envelopes.length, 1, 'an already saved daily subscription is not resubmitted');
  });
  await t.test('a definite rejection allows a fresh attempt', async t => {
    const f = await page(t, rows[0], { rejectFirst: true });
    await f.subscribe(); await f.subscribe();
    const calls = f.calls.filter(item => item.method === 'automation.create');
    assert.deepEqual(calls[1].params, calls[0].params);
    assert.equal(f.envelopes.length, 2);
    assert.equal(f.schedules.length, 1);
    assert.equal(store.get(f.binding).values.scheduleId, f.schedules[0].id);
  });
  await t.test('an uncertain one-off retries the same time but a different time is a new request', async t => {
    const f = await page(t, rows[0], { uncertain: true });
    const first = futureInput();
    await f.once(first); await f.once(first);
    assert.equal(f.schedules.length, 1);
    await f.once(futureInput(120));
    assert.equal(f.schedules.length, 2);
    assert.notEqual(f.envelopes[1].params.requestId, f.envelopes[0].params.requestId);
  });
  await t.test('a completed one-off permits a separate intentional submission', async t => {
    const f = await page(t, rows[0]); const due = futureInput();
    await f.once(due); await f.once(due);
    assert.equal(f.schedules.length, 2);
    assert.notEqual(f.envelopes[1].params.requestId, f.envelopes[0].params.requestId);
    assert.equal(store.get(f.binding).values.scheduleId, undefined);
  });
  await t.test('account change cannot persist a cached successful receipt', async t => {
    const f = await page(t, rows[0]); f.faults.save = true;
    await f.subscribe(); f.setAccount('robot-schedule/account-b'); await f.subscribe();
    assert.equal(f.schedules.length, 1);
    assert.equal(store.get(f.binding).values.scheduleId, undefined);
    assert.equal(f.element('status').attributes.has('data-error'), true);
  });
});
