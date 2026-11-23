'use strict';
/* Issue #495 (方案二): member-level repository → local path mapping API wrappers. */
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('./renderer-source.cjs'), path = require('node:path'), vm = require('node:vm');

async function fixture(respond) {
  const requests = [];
  const values = new Map([['soduwork_work_hub_url', 'https://fixture.invalid']]);
  const context = {
    console, URL, URLSearchParams, AbortController, FormData,
    navigator: { platform: 'test' }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    dispatchEvent() {}, addEventListener() {},
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) },
    soduWorkAPI: {
      getAppVersion: async () => 'test', getSysInfo: async () => ({}),
      deviceAuthBootstrap: async () => ({ ok: true, stored: true, authState: 'active', user: { id: 'alice' },
        clientId: 'desktop', session: 'fixture', expiresIn: 1800 }),
      configureRunner: async () => ({ ok: true }),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const body = url.includes('/clients/register') ? { ok: true } : respond(url, options);
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../api.js'), 'utf8'), context);
  await context.SoduWorkAPI.registerClient();
  return { api: context.SoduWorkAPI, requests };
}

const rows = [{ gitUrl: 'https://github.com/Org/App', localPath: 'D:/work/app' }];
const plain = value => JSON.parse(JSON.stringify(value));

test('clientRepoPaths reads the member mapping list from the versioned Hub endpoint', async () => {
  const f = await fixture(() => ({ paths: rows }));
  assert.deepEqual(plain(await f.api.clientRepoPaths()), rows);
  const req = f.requests.at(-1);
  assert.ok(req.url.endsWith('/api/v1/client-repo-paths'));
  assert.equal(req.options.method, undefined);
});

test('saveClientRepoPath sends git URL and local path as a JSON PUT body', async () => {
  const f = await fixture(() => ({ paths: rows }));
  assert.deepEqual(plain(await f.api.saveClientRepoPath('https://github.com/Org/App.git', 'D:/work/app')), rows);
  const req = f.requests.at(-1);
  assert.ok(req.url.endsWith('/api/v1/client-repo-paths'));
  assert.equal(req.options.method, 'PUT');
  assert.deepEqual(JSON.parse(req.options.body), { gitUrl: 'https://github.com/Org/App.git', localPath: 'D:/work/app' });
  assert.equal(req.options.headers['Content-Type'], 'application/json');
});

test('deleteClientRepoPath sends the git URL in a DELETE body', async () => {
  const f = await fixture(() => ({ paths: [] }));
  assert.deepEqual(plain(await f.api.deleteClientRepoPath('git@github.com:Org/App.git')), []);
  const req = f.requests.at(-1);
  assert.ok(req.url.endsWith('/api/v1/client-repo-paths'));
  assert.equal(req.options.method, 'DELETE');
  assert.deepEqual(JSON.parse(req.options.body), { gitUrl: 'git@github.com:Org/App.git' });
});

test('malformed mapping responses degrade to an empty list', async () => {
  for (const payload of [{}, { paths: null }, { paths: 'nope' }, null]) {
    const f = await fixture(() => payload);
    assert.deepEqual(plain(await f.api.clientRepoPaths()), []);
    assert.deepEqual(plain(await f.api.saveClientRepoPath('https://github.com/Org/App', 'D:/work/app')), []);
    assert.deepEqual(plain(await f.api.deleteClientRepoPath('https://github.com/Org/App')), []);
  }
});
