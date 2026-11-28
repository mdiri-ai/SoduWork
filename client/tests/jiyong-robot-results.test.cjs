'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const vm = require('node:vm'), crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const maker = require('../scripts/create-jiyong-robots.cjs');
const reader = require('../main/plugin-package-reader.cjs');
const bridge = require('../main/soduwork-app-bridge-contract.cjs');

// Exported page/SDK scripts and SQLite storage are real. DOM/native transport
// are controlled; these checks do not start Electron or a model.
class Element {
  constructor(tag, hidden = false) {
    this.tag = tag; this.hidden = hidden; this.disabled = false;
    this.textContent = ''; this.value = ''; this.children = [];
    this.attributes = new Set(); this.dataset = {};
    this.firstChild = { nodeValue: '' };
  }
  append(...items) { this.children.push(...items); }
  prepend(...items) { this.children.unshift(...items); }
  replaceChildren(...items) { this.children = items; }
  toggleAttribute(name, enabled) { if (enabled) this.attributes.add(name); else this.attributes.delete(name); }
}
function resource(body, name) {
  const item = body.resources.find(item => item.path === name);
  assert.ok(item, name);
  return Buffer.from(item.content, 'base64').toString('utf8');
}
async function exported(t) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-results-export-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  return maker.create({ out });
}
async function page(t, row, locale = 'zh-CN') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-results-db-'));
  const body = reader.readPersonalArchive(fs.readFileSync(row.package));
  const grants = body.ui.contributions[0].source.bridge.capabilities;
  const worker = new Worker(path.resolve(__dirname, '../main/jiyong-data-worker.cjs'), {
    workerData: { file: path.join(root, 'data.sqlite'), declaration: body.jiyong, initialization: { migrations: [] } },
  });
  let sequence = 0, failure;
  const pending = new Map();
  worker.on('message', message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(Object.assign(Error(message.error.message), { code: message.error.code }));
    else request.resolve(message.result);
  });
  worker.on('error', error => {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++sequence;
    pending.set(id, { resolve, reject }); worker.postMessage({ id, method, params });
  });
  t.after(async () => { await worker.terminate(); fs.rmSync(root, { recursive: true, force: true }); });
  await request('initialize');
  for (let start = 0; start < 205; start += 100) {
    const operations = Array.from({ length: Math.min(100, 205 - start) }, (_, offset) => {
      const number = start + offset;
      return { id: 'result_' + String(number).padStart(4, '0'), expectedRevision: 0,
        value: { title: 'Saved result ' + number, content: 'Synthetic result ' + number, dayKey: 'fixture', character: row.key } };
    });
    await request('data.batch', { collection: 'results', operations });
  }
  const elements = new Map(), selectors = new Map(), calls = [], listeners = new Map(), hooks = {};
  for (const match of resource(body, 'ui/index.html').matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    elements.set(match[2], new Element(match[1].toLowerCase(), /\bhidden\b/.test(match[0])));
  }
  const document = {
    referrer: '', documentElement: { lang: 'zh-CN' }, getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, new Element('div'));
      return selectors.get(selector);
    },
    querySelectorAll: selector => selector === 'button' ? [...elements.values()].filter(e => e.tag === 'button') : [],
  };
  const window = {
    crypto: crypto.webcrypto,
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    soduWorkAppBridge: {
      events: { onTurnSettled() {}, onDataChanged() {} },
      async request(method, params) {
        bridge.normalizeRequest({ id: 'results-call-' + (calls.length + 1), method, params });
        assert.ok(bridge.hasCapability(grants, bridge.METHOD_CAPABILITY[method]), method);
        const call = { method, params }; calls.push(call);
        if (method === 'context.get') return { ok: true, locale };
        if (method === 'settings.get') return { ok: true, values: {}, revision: 0 };
        assert.equal(method, 'data.list');
        await hooks.beforeList?.(params);
        if (params.after && hooks.rejectNextPage) {
          hooks.rejectNextPage = false;
          return { ok: false, reason: 'Controlled results read refusal' };
        }
        call.reply = await request(method, params);
        return call.reply;
      },
    },
  };
  window.parent = window;
  const location = { origin: 'https://robot-results.invalid', href: 'https://robot-results.invalid/ui/index.html' };
  const context = vm.createContext({ window, document, location, URL, Uint8Array, setTimeout, clearTimeout });
  for (const name of ['ui/config.js', 'ui/soduwork-app.js', 'ui/app.js']) {
    vm.runInContext(resource(body, name), context, { filename: name });
  }
  const deadline = Date.now() + 5000;
  while (vm.runInContext('busy', context) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(vm.runInContext('busy', context), false, 'page initialized');
  assert.equal(elements.get('status').attributes.has('data-error'), false, elements.get('status').textContent);
  const resultCalls = () => calls.filter(c => c.method === 'data.list' && c.params.collection === 'results');
  const titles = () => elements.get('results').children.map(card => card.children[0]?.textContent);
  return { elements, hooks, request, resultCalls, titles,
    more: () => elements.get('more-results'),
    focus: async () => { for (const listener of listeners.get('focus') || []) await listener(); } };
}
test('five exported robots browse every saved result through the existing SDK and SQLite cursor', async t => {
  for (const [index, row] of (await exported(t)).entries()) await t.test(row.key, async t => {
    const f = await page(t, row, index === 1 ? 'en-US' : 'zh-CN');
    assert.equal(f.titles().length, 100);
    assert.equal(f.resultCalls()[0].reply.next, 'result_0099', 'storage already exposes the next page');
    assert.ok(f.more(), 'exported page provides a way to continue browsing results');
    assert.equal(f.more().hidden, false);
    assert.equal(f.more().textContent, index === 1 ? 'Load more results' : '加载更多成果');
    await f.more().onclick(); assert.equal(f.titles().length, 200);
    await f.more().onclick(); assert.equal(f.titles().length, 205);
    assert.equal(new Set(f.titles()).size, 205);
    assert.equal(f.more().hidden, true);
    assert.deepEqual(f.resultCalls().map(c => c.params.after), [undefined, 'result_0099', 'result_0199']);
    const all = f.resultCalls().flatMap(c => c.reply.items);
    assert.deepEqual(f.titles(), all.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(r => r.value.title));
    const count = f.resultCalls().length;
    await f.more().onclick(); assert.equal(f.resultCalls().length, count, 'end of collection does not request another page');
  });
});
test('a rejected next page retains saved cards and retries the same cursor', async t => {
  const f = await page(t, (await exported(t))[0]);
  assert.ok(f.more()); const first = f.titles(); f.hooks.rejectNextPage = true;
  await f.more().onclick();
  assert.deepEqual(f.titles(), first);
  assert.equal(f.elements.get('status').textContent, 'Controlled results read refusal');
  assert.equal(f.more().hidden, false); assert.equal(f.more().disabled, false);
  await f.more().onclick();
  assert.equal(f.titles().length, 200);
  assert.deepEqual(f.resultCalls().slice(-2).map(c => c.params.after), ['result_0099', 'result_0099']);
});
test('refresh replaces loaded results and resets the cursor to current storage', async t => {
  const f = await page(t, (await exported(t))[0]); assert.ok(f.more());
  await f.more().onclick(); assert.equal(f.titles().length, 200);
  await f.request('data.batch', { collection: 'results', operations: [{ id: 'result_0000', expectedRevision: 1, delete: true }] });
  await f.elements.get('refresh').onclick();
  assert.equal(f.titles().length, 100);
  assert.equal(f.titles().includes('Saved result 0'), false);
  assert.equal(f.resultCalls().at(-1).params.after, undefined);
  await f.more().onclick();
  assert.equal(f.titles().length, 200); assert.equal(f.more().hidden, false);
  assert.equal(f.resultCalls().at(-1).params.after, 'result_0100');
  await f.more().onclick();
  assert.equal(f.titles().length, 204); assert.equal(f.more().hidden, true);
});
test('a focus refresh holds the page lock until results settle, preventing a stale cursor request', async t => {
  const f = await page(t, (await exported(t))[0]); assert.ok(f.more());
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  t.after(release);
  f.hooks.beforeList = async params => { if (params.collection === 'results' && !params.after) { entered(); await gate; } };
  const refreshing = f.focus(); await ready;
  try {
    assert.equal(f.more().disabled, true);
    const count = f.resultCalls().length;
    await f.more().onclick(); assert.equal(f.resultCalls().length, count);
  } finally { release(); }
  await refreshing;
  assert.equal(f.titles().length, 100); assert.equal(f.more().disabled, false);
});
