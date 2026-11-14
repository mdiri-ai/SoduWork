'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const renderer = require('./renderer-source.cjs');
const store = require('../main/local-model-store.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-save-outcome-'));
  store.configure({ app: { getPath: () => root }, safeStorage: {
    isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text),
    decryptString: bytes => bytes.toString(),
  } });
  t.after(() => { store.configure(null); fs.rmSync(root, { recursive: true, force: true }); });
  store.save({ providers: [{ id: 'custom-private', name: 'Private service',
    baseUrl: 'http://127.0.0.1:1/v1', authMode: 'none' }],
  models: [{ providerId: 'custom-private', name: 'private-model' }] });
  const managed = { revision: 'hub-1', providers: [{ id: 'managed', name: 'Managed service',
    baseUrl: 'https://fixture.invalid/v1', modelNames: [], personal: false }], myModels: [], usable: [] };
  const state = { failHubWrite: false, failHubRead: false, localInputs: [], hubInputs: [], notices: [], gate: null };
  const values = new Map(), button = { disabled: false, textContent: '' }, field = { disabled: false };
  const body = { innerHTML: '', setAttribute() {}, removeAttribute() {}, querySelector: () => null,
    querySelectorAll: selector => selector === 'input,select,textarea,button' ? [field] : [] };
  const box = { URL, URLSearchParams, AbortController, Response, CustomEvent: class {}, structuredClone,
    __SODUWORK_TEST_HUB_CONFIG__: { allowSwitch: true },
    setTimeout, clearTimeout, setInterval: () => 0, navigator: { platform: 'test' },
    console: { log() {}, error() {} }, dispatchEvent() {}, addEventListener() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key) },
    document: { getElementById: id => id === 'mdBody' ? body : id === 'mdSave' ? button : null },
    petSay: message => state.notices.push(message),
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    soduWorkAPI: { localModels: { get: async () => store.get(), save: async input => {
      state.localInputs.push(structuredClone(input));
      if (state.gate) await state.gate;
      return store.save(input);
    } } },
    fetch: async (url, options = {}) => {
      if (options.method === 'PUT') {
        const input = JSON.parse(options.body); state.hubInputs.push(input);
        if (state.failHubWrite) throw Error('Synthetic Hub write failure');
        assert.equal(input.expectedRevision, managed.revision);
        managed.providers = input.providers; managed.myModels = input.models;
        managed.revision = 'hub-' + (Number(managed.revision.split('-')[1]) + 1);
        return new Response('{"ok":true}');
      }
      if (state.failHubRead) throw Error('Synthetic Hub read failure');
      return new Response(JSON.stringify(managed));
    },
  };
  box.window = box; vm.createContext(box);
  const human = fs.readFileSync(path.join(__dirname, '../components/pet/pet-ui.js'), 'utf8');
  vm.runInContext(human.slice(human.indexOf('function _humanErr('), human.indexOf('/* Speech bubbles. */')), box);
  vm.runInContext(renderer.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), box);
  for (const file of ['model-capabilities.js', 'model-catalog-editor.js', 'model-service-delete.js', 'panels-models.js'])
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), box, { filename: file });
  const evaluate = source => vm.runInContext(source, box);
  await evaluate('_mdLoad()');
  return { state, box, button, field, body, evaluate, snapshot: () => store.get(),
    touch: (id, patch) => evaluate(`_mdTouchProvider(${JSON.stringify(id)}, ${JSON.stringify(patch)})`),
    async removeProvider(id) {
      box.deletePlan = await evaluate(`_mdPrepareServiceDelete(${JSON.stringify(id)})`);
      return evaluate('_mdDeleteService(deletePlan)');
    } };
}

test('a partial mixed save retains Hub edits and retries without rewriting committed local models', async t => {
  const f = await fixture(t);
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  f.touch('custom-private', { name: 'Saved local edit' });
  f.state.failHubWrite = true;
  assert.equal(await f.evaluate('_mdSave(false)'), false);
  assert.equal(f.snapshot().providers[0].name, 'Saved local edit');
  assert.equal(f.snapshot().revision, 2);
  assert.equal(f.evaluate('_mdData.localRevision'), 2);
  assert.equal(f.evaluate('_mdLocalDirty'), false);
  assert.equal(f.evaluate('_mdManagedDirty'), true);
  assert.equal(f.evaluate('_mdProvider("managed").baseUrl'), 'https://edited.fixture.invalid/v1');
  assert.ok(f.state.notices.includes('本地模型配置已保存，Hub 模型配置未保存，请重试。'));
  f.state.failHubWrite = false;
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.state.localInputs.length, 1, 'retry must not replay the already committed local revision');
  assert.equal(f.state.hubInputs.length, 2);
  assert.equal(f.evaluate('_mdManagedDirty'), false);
  assert.equal(JSON.stringify(f.state.hubInputs).includes('custom-private'), false);
});

test('deleting the last local service never sends its removal key to a later managed save', async t => {
  const f = await fixture(t);
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  assert.equal(await f.removeProvider('custom-private'), true);
  assert.equal(f.snapshot().providers.length, 0);
  assert.equal(f.state.localInputs.length, 1);
  assert.equal(f.state.hubInputs.length, 0, 'deleting a local service must not submit an unrelated managed draft');
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.state.hubInputs.length, 1);
  assert.equal(JSON.stringify(f.state.hubInputs).includes('custom-private'), false);
});

test('last-provider deletion survives a failed Hub reload and keeps local editing usable', async t => {
  const f = await fixture(t);
  f.state.failHubRead = true;
  assert.equal(await f.removeProvider('custom-private'), true);
  assert.equal(f.snapshot().providers.length, 0);
  assert.equal(f.evaluate('_mdData.localRevision'), 2);
  assert.equal(f.evaluate('_mdData.usable.length'), 0);
  assert.equal(f.evaluate('_mdLoadState'), 'ready');
  assert.equal(f.evaluate('_mdDirty'), false);
  assert.doesNotMatch(f.body.innerHTML, /data-md-load-error/);
  assert.equal(f.state.notices.some(message => message.includes('没存上')), false);
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Replacement local', baseUrl: 'http://127.0.0.1:2/v1', authMode: 'none' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Replacement local');
  assert.equal(f.state.hubInputs.length, 0);
});

test('pending local persistence disables edits and joins reentrant saves without losing a later edit', async t => {
  const f = await fixture(t);
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  f.touch('custom-private', { name: 'First explicit edit' });
  const first = f.evaluate('_mdSave(false)'), second = f.evaluate('_mdSave(false)');
  assert.equal(f.button.disabled, true);
  assert.equal(f.field.disabled, true);
  for (let i = 0; !f.state.localInputs.length && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.localInputs.length, 1);
  f.touch('custom-private', { name: 'Unaccepted in-flight event' });
  assert.equal(f.evaluate('_mdProvider("custom-private").name'), 'First explicit edit');
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(f.state.localInputs.length, 1);
  assert.equal(f.field.disabled, false);
  f.touch('custom-private', { name: 'Second explicit edit' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Second explicit edit');
  assert.equal(f.snapshot().revision, 3);
});

test('a committed local save stays successful when catalog rendering fails', async t => {
  const f = await fixture(t);
  f.touch('custom-private', { name: 'Persisted before render failure' });
  f.evaluate('_mdRender = () => { throw Error("Synthetic rendering failure"); }');
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Persisted before render failure');
  assert.equal(f.evaluate('_mdLocalDirty'), false);
  assert.ok(f.state.notices.includes('模型配置已保存，但模型清单刷新失败，请重新打开模型页面。'));
});

for (const change of ['hub', 'panel']) test(`a ${change} switch during local persistence cannot send the old managed draft`, async t => {
  const f = await fixture(t);
  let release;
  f.state.gate = new Promise(resolve => { release = resolve; });
  f.touch('managed', { baseUrl: 'https://previous.fixture.invalid/v1' });
  f.touch('custom-private', { name: 'Local edit' });
  const saved = f.evaluate('_mdSave(false)');
  for (let i = 0; !f.state.localInputs.length && i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.localInputs.length, 1);
  if (change === 'hub') f.box.SoduWorkAPI.setHubEnvironment('development', 'http://127.0.0.1:9876');
  else f.evaluate('closeModelsPanel()');
  release();
  assert.equal(await saved, false);
  assert.equal(f.snapshot().providers[0].name, 'Local edit');
  assert.equal(f.state.hubInputs.length, 0);
});

test('a name-only service stays visibly unsaved and reports the missing API address', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  f.touch(f.evaluate('_mdNew.id'), { name: 'Incomplete service' });
  assert.equal(await f.evaluate('_mdSave(false)'), false);
  assert.equal(f.state.localInputs.length, 0);
  assert.equal(f.snapshot().revision, 1);
  assert.ok(f.state.notices.includes('请填写 API 地址'));
  assert.match(f.body.innerHTML, /cfg-state is-draft[^>]*>未保存/);
  assert.equal(f.button.disabled, false);
});

test('reopening keeps a new service and its key and model pending until a successful write', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Pending service' });
  f.evaluate(`_mdKeyEdits[${JSON.stringify(id)}] = 'synthetic-draft-key';
    _mdMyModels.push({providerId:${JSON.stringify(id)}, name:'draft-model'});
    closeModelsPanel(); _mdEditor = '';`);
  assert.equal(await f.evaluate('_mdLoad()'), true);
  assert.equal(f.evaluate('_mdNew.id'), id);
  assert.equal(f.evaluate(`_mdKeyEdits[${JSON.stringify(id)}]`), 'synthetic-draft-key');
  assert.equal(f.evaluate(`_mdMyModels.some(row => row.providerId === ${JSON.stringify(id)})`), true);
  assert.equal(f.evaluate('_mdLocalDirty && _mdDirty'), true);
  assert.equal(f.button.disabled, false);
  assert.equal(f.button.textContent, '保存');
  assert.equal(f.snapshot().revision, 1);
  f.touch(id, { baseUrl: 'http://127.0.0.1:2/v1' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers.some(row => row.id === id), true);
  assert.equal(f.evaluate('_mdNew'), null);
  assert.equal(f.button.textContent, '已保存');
});

test('saving another local service leaves an incomplete new service pending', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Unfinished new service' });
  f.evaluate(`_mdKeyEdits[${JSON.stringify(id)}] = 'synthetic-pending-key';
    _mdMyModels.push({providerId:${JSON.stringify(id)}, name:'pending-model', localOnly:true});`);
  f.evaluate('_mdOpen = "custom-private"; _mdEditor = "";');
  f.touch('custom-private', { name: 'Explicitly saved edit' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.snapshot().providers[0].name, 'Explicitly saved edit');
  assert.equal(f.snapshot().providers.length, 1);
  assert.equal(f.evaluate('_mdNew.id'), id);
  assert.equal(f.evaluate(`_mdKeyEdits[${JSON.stringify(id)}]`), 'synthetic-pending-key');
  assert.equal(f.evaluate(`_mdMyModels.filter(row=>row.providerId===${JSON.stringify(id)}).length`), 1);
  assert.equal(JSON.stringify(f.state.localInputs).includes(id), false);
  assert.equal(f.evaluate('_mdLocalDirty && _mdDirty'), true);
  assert.equal(f.button.textContent, '保存');
  assert.ok(f.state.notices.includes('其他模型配置已保存，新增服务尚未保存，请补全后保存。'));
});

test('an incomplete new draft cannot force a local write during a managed save', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService(); _mdOpen = "managed"; _mdEditor = "";');
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.state.localInputs.length, 0);
  assert.equal(f.state.hubInputs.length, 1);
  assert.equal(f.snapshot().revision, 1);
  assert.equal(f.evaluate('_mdLocalDirty && _mdDirty'), true);
});

test('a draft confirmed in storage is cleared even after the editor selection changes', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  store.save({ providers: [...f.snapshot().providers,
    { id, name: 'Committed elsewhere', baseUrl: 'http://127.0.0.1:2/v1', authMode: 'none' }] });
  f.evaluate('closeModelsPanel(); _mdEditor = "";');
  assert.equal(await f.evaluate('_mdLoad()'), true);
  assert.equal(f.evaluate('_mdNew'), null);
  assert.equal(f.evaluate('_mdDirty'), false);
  assert.equal(f.button.textContent, '已保存');
});

test('an unsaved new service is not carried into a different Hub scope', async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Previous Hub draft' });
  f.box.SoduWorkAPI.setHubEnvironment('development', 'http://127.0.0.1:9876');
  assert.equal(await f.evaluate('_mdLoad()'), true);
  assert.equal(f.evaluate('_mdNew'), null);
  assert.doesNotMatch(f.body.innerHTML, /Previous Hub draft/);
});

for (const kind of ['connection', 'capability']) test(`${kind} checks ignore an unrelated incomplete service draft`, async t => {
  const f = await fixture(t);
  let probes = 0;
  f.box.SoduWorkAPI.testMyModel = async () => { probes++; return { ok: true, models: ['private-model'] }; };
  f.box.SoduWorkAPI.checkMyModelCapabilities = async () => { probes++; return { ok: true }; };
  f.evaluate('_mdAddService()');
  const id = f.evaluate('_mdNew.id');
  f.touch(id, { name: 'Pending service' });
  f.evaluate(`_mdMyModels.push({providerId:${JSON.stringify(id)}, name:'pending-model', localOnly:true});
    _mdOpen = 'custom-private'; _mdEditor = '';`);
  if (kind === 'connection') await f.evaluate('_mdDoTest({getAttribute:()=>"custom-private"})');
  else await f.evaluate('_mdCheckModel("custom-private", "private-model")');
  assert.equal(probes, 1);
  assert.equal(f.state.localInputs.length, 0);
  assert.equal(f.snapshot().revision, 1);
  assert.equal(f.evaluate(`_mdMyModels.some(row=>row.providerId===${JSON.stringify(id)})`), true);
  assert.equal(f.evaluate('_mdDirty'), true);
});

test('a saved local service that requires a missing key is not presented as locally available', async t => {
  const f = await fixture(t);
  f.touch('custom-private', { authMode: 'key' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.evaluate('_mdState(_mdProvider("custom-private"))'), 'open');
});

for (const baseUrl of ['http://', 'not-a-url']) test(`an invalid API address (${baseUrl}) reports its field before writing`, async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  f.touch(f.evaluate('_mdNew.id'), { name: 'Invalid address', baseUrl });
  assert.equal(await f.evaluate('_mdSave(false)'), false);
  assert.equal(f.state.localInputs.length, 0);
  assert.match(f.body.innerHTML, /data-purl="[^"]+"[^>]*aria-invalid="true"/);
  assert.doesNotMatch(f.state.notices.at(-1), /没存上/);
});

test('reloading a saved service clears validation for an invalid edit that was discarded', async t => {
  const f = await fixture(t);
  f.touch('custom-private', { baseUrl: 'invalid' });
  assert.equal(await f.evaluate('_mdSave(false)'), false);
  assert.match(f.body.innerHTML, /aria-invalid="true"/);
  f.evaluate('closeModelsPanel(); _mdEditor = "";');
  assert.equal(await f.evaluate('_mdLoad()'), true);
  assert.equal(f.evaluate('_mdProvider("custom-private").baseUrl'), 'http://127.0.0.1:1/v1');
  assert.equal(f.button.textContent, '已保存');
  assert.doesNotMatch(f.body.innerHTML, /aria-invalid="true"/);
});

for (const patch of [{ name: 'n'.repeat(65) }, { baseUrl: 'https://fixture.invalid/v1/'.padEnd(401, 'x') }])
test(`an oversized draft ${Object.keys(patch)[0]} cannot block another service save`, async t => {
  const f = await fixture(t);
  f.evaluate('_mdAddService()');
  f.touch(f.evaluate('_mdNew.id'), { name: 'Draft service', baseUrl: 'https://fixture.invalid/v1', ...patch });
  f.evaluate('_mdOpen = "managed"; _mdEditor = "";');
  f.touch('managed', { baseUrl: 'https://edited.fixture.invalid/v1' });
  assert.equal(await f.evaluate('_mdSave(false)'), true);
  assert.equal(f.state.localInputs.length, 0);
  assert.equal(f.state.hubInputs.length, 1);
  assert.equal(f.evaluate('_mdDirty'), true);
});
