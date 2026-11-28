'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { readManifest, runnerPath, requiredFiles, verify } = require('../scripts/verify-runtime.cjs');

const root = path.resolve(__dirname, '..');

test('runtime manifest declares a zero-prerequisite client', () => {
  const manifest = readManifest(root);
  assert.deepEqual(manifest.hostPrerequisites, []);
  assert.equal(manifest.networkInstall, false);
  assert.equal(manifest.bundled.runner.required, true);
});

test('runner location is deterministic and never resolved from PATH', () => {
  assert.match(runnerPath(root, 'win32').replaceAll('\\', '/'), /resources\/runner\/soduwork-runner\.exe$/);
  assert.match(runnerPath(root, 'linux').replaceAll('\\', '/'), /resources\/runner\/soduwork-runner$/);
});

test('source checkout reports missing generated runner clearly', () => {
  assert.throws(() => verify(root, process.platform, { packaged: true }), /ENOENT/);
});
test('package gate rejects each missing component and accepts a complete resource tree', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-runtime-gate-'));
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const resources = path.join(temp, 'resources');
  fs.mkdirSync(resources);
  const manifest = readManifest(root);
  fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify(manifest));
  const files = requiredFiles(manifest, 'win32');
  for (const relative of files) {
    const file = path.join(resources, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  assert.equal(verify(temp, 'win32', { packaged: true }).checkedFiles, files.length);
  for (const relative of files) {
    const file = path.join(resources, relative); fs.writeFileSync(file, '');
    assert.throws(() => verify(temp, 'win32', { packaged: true }), /missing or empty/);
    fs.writeFileSync(file, 'fixture');
  }
  manifest.hostPrerequisites = ['python'];
  fs.writeFileSync(path.join(resources, 'runtime-manifest.json'), JSON.stringify(manifest));
  assert.throws(() => verify(temp, 'win32', { packaged: true }), /hostPrerequisites/);
});
test('Windows npm survives electron-builder root node_modules filtering', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-node-copy-'));
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  const relative = '.runtime/node/node_modules/npm/bin/npm-cli.js';
  const source = path.join(temp, relative);
  fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'npm entry');
  const pkg = require('../package.json');
  const mapping = pkg.build.win.extraResources.find(item => item.to === 'node/node_modules');
  assert.ok(mapping, 'npm requires an explicit resource root');
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const output = path.join(temp, 'resources', mapping.to);
  await copyFiles([new FileMatcher(path.join(temp, mapping.from), output, value => value, mapping.filter)]);
  assert.equal(fs.readFileSync(path.join(output, 'npm/bin/npm-cli.js'), 'utf8'), 'npm entry');
});

const armonelTargets = [
  ['darwin', 'arm64', 'mac'], ['darwin', 'x64', 'mac'], ['linux', 'x64', 'linux'], ['win32', 'x64', 'win'],
];

async function copyArmonelToResources(temp, platform, arch, section) {
  const { selectRelease, noticeNames, bundledExecutable } = require('../main/armonel-runtime.cjs');
  const { FileMatcher, copyFiles } = require('app-builder-lib/out/fileMatcher');
  const mapping = require('../package.json').build[section].extraResources.find(item => item.to === 'armonel');
  const release = selectRelease(platform, arch);
  const dir = path.resolve(temp, mapping.from.replace('${arch}', arch));
  const resources = path.join(temp, release.target, platform === 'darwin' ? 'SoduWork.app/Contents/Resources' : 'resources');
  const names = [release.executable, ...noticeNames];
  assert.deepEqual(mapping.filter, names);
  assert.equal(bundledExecutable({ isPackaged: false, getAppPath: () => temp }, null, platform, arch), path.join(dir, release.executable));
  assert.equal(bundledExecutable({ isPackaged: true }, resources, platform, arch), null);
  await copyFiles([new FileMatcher(dir, path.join(resources, mapping.to), value => value, mapping.filter)]);
  assert.deepEqual(fs.readdirSync(path.join(resources, mapping.to)).sort(), names.slice().sort());
  const required = requiredFiles(readManifest(root), platform, arch);
  for (const name of names) assert.ok(required.includes('armonel/' + name));
  return bundledExecutable({ isPackaged: true }, resources, platform, arch);
}

test('each supported installer resolves its pinned Armonel resources and rejects invalid inputs', async t => {
  const { selectRelease, noticeNames, bundledExecutable } = require('../main/armonel-runtime.cjs');
  const { prepare } = require('../scripts/prepare-armonel-runtime.cjs');
  const catalog = require('../../hub-backend/app/agent_catalog.json');
  const agent = catalog.agents.find(item => item.id === 'armonel');
  assert.equal(agent.install.installer, 'bundled');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-gate-'));
  t.after(() => { assert.equal(path.dirname(temp), os.tmpdir()); fs.rmSync(temp, { recursive: true, force: true }); });
  mockArchiveRequests(t, () => ({ status: 404 }));
  await assert.rejects(prepare({ root: temp, platform: 'darwin', arch: 'arm64', env: {} }), /HTTP 404/);
  for (const [platform, arch, section] of armonelTargets) {
    const release = selectRelease(platform, arch);
    assert.equal(agent.install.version, release.version);
    assert.equal(release.name, 'armonel-' + platform + '-' + arch);
    const dir = path.join(temp, '.runtime', 'armonel', release.target);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of [release.executable, ...noticeNames]) fs.writeFileSync(path.join(dir, name), release.target);
    const resolved = await copyArmonelToResources(temp, platform, arch, section);
    assert.equal(fs.readFileSync(resolved, 'utf8'), release.target);
  }
  const archive = path.join(temp, 'wrong.tgz');
  fs.writeFileSync(archive, 'incorrect archive');
  await assert.rejects(prepare({ root: temp, platform: 'win32', arch: 'x64',
    env: { SODUWORK_ARMONEL_PACKAGE: archive } }), /failed SHA-256/);
  assert.equal(bundledExecutable({ isPackaged: true }, temp, 'win32', 'arm64'), null);
});

test('source startup tolerates an unreachable default registry but rejects bad configuration and payloads', async t => {
  const { prepare } = require('../scripts/prepare-armonel-runtime.cjs');
  const release = require('../main/armonel-runtime.cjs').selectRelease('win32', 'x64');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-source-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const options = { root: temp, platform: 'win32', arch: 'x64', env: {}, sourceCheckout: true };
  const offline = { error: Object.assign(Error('registry offline'), { code: 'ENOTFOUND' }) };
  let response = offline;
  mockArchiveRequests(t, () => response);
  assert.equal(await prepare(options), null);
  assert.equal(fs.existsSync(path.join(temp, '.runtime')), false);
  await assert.rejects(prepare({ ...options, sourceCheckout: false }), { code: 'ENOTFOUND' });
  await assert.rejects(prepare({ ...options, env: { SODUWORK_ARMONEL_NPM_REGISTRY: 'https://nexus.example.test' } }),
    { code: 'ENOTFOUND' });
  response = { status: 404 };
  await assert.rejects(prepare(options), /HTTP 404/);
  response = {};
  await assert.rejects(prepare(options), /SHA-256 mismatch/);
  response = offline;
  await assert.rejects(prepare({ ...options, env: { SODUWORK_ARMONEL_NPM_REGISTRY: 'http://insecure.example.test' } }), /Invalid Armonel registry URL/);
  await assert.rejects(prepare({ ...options, env: { SODUWORK_ARMONEL_PACKAGE: path.join(temp, 'missing.tgz') } }), { code: 'ENOENT' });
  const checkout = path.join(temp, 'checkout', 'client');
  const archive = path.join(checkout, 'runtime-packages', 'armonel', release.version, release.file);
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, '');
  await assert.rejects(prepare({ ...options, archiveRoot: checkout }), /failed SHA-256/);
  fs.unlinkSync(archive);
  const cache = path.join(temp, '.runtime-cache', 'armonel', release.file);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.writeFileSync(cache, 'wrong cached contents');
  await assert.rejects(prepare(options), /cached archive failed SHA-256/);
  fs.unlinkSync(cache);
  const binary = path.join(temp, '.runtime', 'armonel', release.target, release.executable);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'wrong staged contents');
  await assert.rejects(prepare(options), /Invalid staged Armonel runtime/);
});

test('a clean checkout prepares each pinned Armonel offline and runs native ACP from final resources', async t => {
  const { prepare } = require('../scripts/prepare-armonel-runtime.cjs');
  const { selectRelease } = require('../main/armonel-runtime.cjs');
  const { version } = require('../main/armonel-release.json');
  const archives = path.join('runtime-packages', 'armonel', version);
  const files = armonelTargets.map(([platform, arch]) => selectRelease(platform, arch).file);
  const missing = files.filter(file => !fs.existsSync(path.join(root, archives, file)));
  if (missing.length === files.length && !process.env.SODUWORK_ARMONEL_NPM_REGISTRY?.trim() &&
      process.env.SODUWORK_REQUIRE_ARMONEL_ARCHIVES !== '1') {
    return t.skip('No platform archives supplied; run npm run vendor:armonel to enable the native packaging test.');
  }
  assert.deepEqual(missing, [], 'Missing pinned Armonel archives. Run npm run vendor:armonel before native packaging tests.');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-native-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const checkout = path.join(temp, 'checkout', 'client');
  fs.mkdirSync(path.join(checkout, archives), { recursive: true });
  const cache = path.join(temp, '.runtime-cache', 'armonel');
  fs.mkdirSync(cache, { recursive: true });
  const calls = mockArchiveRequests(t, () => ({ status: 404 }));
  for (const [platform, arch, section] of armonelTargets) {
    const release = selectRelease(platform, arch);
    const archive = path.join(archives, release.file);
    fs.copyFileSync(path.join(root, archive), path.join(checkout, archive));
    assert.equal(createHash('sha256').update(fs.readFileSync(path.join(checkout, archive))).digest('hex'), release.sha256);
    // Cross-packaging Intel on Apple Silicon requires Rosetta; a native checkout only requires its own executable.
    if (process.platform === 'darwin' && process.arch === 'arm64' && release.target === 'darwin-x64') continue;
    fs.writeFileSync(path.join(cache, release.file), 'stale cache must not override the bundled package');
    const options = { root: temp, platform, arch, env: {}, archiveRoot: checkout };
    const staged = await prepare(options);
    fs.unlinkSync(path.join(checkout, archive));
    // The stale cache must not force a download over a valid staged executable.
    const before = calls.length;
    assert.equal(await prepare({ ...options, sourceCheckout: true }), staged);
    assert.equal(calls.length, before, 'validated source runtime must start offline');
    await assert.rejects(prepare(options), /HTTP 404/);
    const resolved = await copyArmonelToResources(temp, platform, arch, section);
    assert.equal(createHash('sha256').update(fs.readFileSync(resolved)).digest('hex'), release.binary_sha256);
    if (platform === process.platform && arch === process.arch) {
      await require('../scripts/check-armonel-acp.cjs').checkAcp(resolved);
    }
  }
});

function mockArchiveRequests(t, route) {
  const { EventEmitter } = require('node:events');
  const { Readable } = require('node:stream');
  const calls = [];
  t.mock.method(require('node:https'), 'get', (url, options, respond) => {
    calls.push([String(url), new Headers(options.headers).get('job-token')]);
    const { location, body, status = 200, error } = route(String(url));
    const request = Object.assign(new EventEmitter(), { setTimeout() {} });
    if (error) {
      queueMicrotask(() => request.emit('error', error));
      return request;
    }
    const response = body ?? Readable.from([]);
    response.statusCode = location ? 302 : status;
    response.headers = location ? { location } : {};
    queueMicrotask(() => respond(response));
    return request;
  });
  return calls;
}

test('Armonel registry selects npm before GitLab, scopes job tokens, and discards corrupt downloads', async t => {
  const { Readable } = require('node:stream');
  const { prepare } = require('../scripts/prepare-armonel-runtime.cjs');
  const { selectRelease } = require('../main/armonel-runtime.cjs');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-download-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const storage = 'https://storage.example.test/download';
  const calls = mockArchiveRequests(t, url => url === storage
    ? { body: Readable.from(['unverified contents']) } : { location: storage });
  const api = 'https://gitlab.example.test/api/v4';
  const env = { CI_API_V4_URL: api, CI_JOB_TOKEN: 'fixture-token', SODUWORK_ARMONEL_PROJECT_ID: '12' };
  await assert.rejects(prepare({ root: temp, platform: 'darwin', arch: 'arm64', env }), /SHA-256 mismatch/);
  const release = selectRelease('darwin', 'arm64');
  assert.deepEqual(calls, [
    [`${api}/projects/12/packages/generic/armonel-npm/${release.version}/${release.file}`, 'fixture-token'],
    [storage, null],
  ]);
  calls.length = 0;
  // Deliberately share a host and API prefix to prove npm requests never receive GitLab credentials.
  const registry = api + '/repository/npm/';
  await assert.rejects(prepare({ root: temp, platform: 'darwin', arch: 'arm64',
    env: { ...env, SODUWORK_ARMONEL_NPM_REGISTRY: registry } }), /SHA-256 mismatch/);
  assert.deepEqual(calls, [
    [registry + release.name + '/-/' + release.file, null],
    [storage, null],
  ]);
  assert.deepEqual(fs.readdirSync(path.join(temp, '.runtime-cache', 'armonel')), []);
  assert.equal(fs.existsSync(path.join(temp, '.runtime', 'armonel')), false);
});

test('source startup and installers fetch every target from the project registry without machine configuration', async t => {
  const { prepare } = require('../scripts/prepare-armonel-runtime.cjs');
  const { selectRelease } = require('../main/armonel-runtime.cjs');
  const registry = require('../scripts/armonel-npm-registry.json');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-default-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const calls = mockArchiveRequests(t, () => ({ status: 404 }));
  for (const [platform, arch] of armonelTargets) {
    const release = selectRelease(platform, arch);
    for (const sourceCheckout of [true, false]) {
      // npm lifecycle scripts can include a general registry even on an otherwise unconfigured host.
      const env = sourceCheckout ? {} : { npm_config_registry: 'https://registry.npmjs.org/' };
      await assert.rejects(prepare({ root: temp, platform, arch, sourceCheckout, env }), /HTTP 404/);
      assert.deepEqual(calls.pop(), [registry.replace(/\/+$/, '') + '/' + release.name + '/-/' + release.file, null]);
    }
  }
  const release = selectRelease('darwin', 'arm64');
  const mirror = 'https://mirror.example.test/armonel';
  await assert.rejects(prepare({ root: temp, platform: 'darwin', arch: 'arm64',
    env: { SODUWORK_ARMONEL_PACKAGE_BASE_URL: mirror } }), /HTTP 404/);
  assert.deepEqual(calls, [[mirror + '/' + release.version + '/' + release.file, null]]);
});

test('vendoring Armonel fills missing platform packages and works offline on later runs', async t => {
  const { vendorArchives } = require('../scripts/prepare-armonel-runtime.cjs');
  const { Readable } = require('node:stream');
  const version = '1.0.0-test';
  const releases = armonelTargets.map(([platform, arch]) => {
    const target = platform + '-' + arch;
    const name = 'armonel-' + target;
    const file = name + '-' + version + '.tgz';
    return { name, file, target, sha256: createHash('sha256').update(file).digest('hex') };
  });
  const releaseManifest = { version, packages: [...releases, { name: 'armonel', file: 'armonel-' + version + '.tgz' }] };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-vendor-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const relative = path.join('runtime-packages', 'armonel', version);
  const bundled = path.join(temp, relative);
  const cache = path.join(temp, '.runtime-cache', 'armonel');
  fs.mkdirSync(bundled, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  const [local, cached, ...missing] = releases;
  fs.writeFileSync(path.join(bundled, local.file), local.file);
  fs.writeFileSync(path.join(cache, cached.sha256), cached.file);
  fs.writeFileSync(path.join(cache, missing[0].sha256), 'corrupt cached download');
  const registry = require('../scripts/armonel-npm-registry.json').replace(/\/+$/, '');
  const sources = new Map(missing.map(release => [
    `${registry}/${release.name}/-/${release.file}`, release.file,
  ]));
  const calls = mockArchiveRequests(t, url => {
    assert.ok(sources.has(url), 'Unexpected archive request: ' + url);
    return { body: Readable.from([sources.get(url)]) };
  });
  await vendorArchives({ root: temp, releaseManifest, env: {} });
  assert.deepEqual(calls.map(([url]) => url).sort(), [...sources.keys()].sort());
  assert.deepEqual(fs.readdirSync(bundled).sort(), releases.map(release => release.file).sort());
  assert.equal(fs.readFileSync(path.join(cache, missing[0].sha256), 'utf8'), missing[0].file);
  for (const release of releases) {
    const bytes = fs.readFileSync(path.join(bundled, release.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha256);
  }
  calls.length = 0;
  await vendorArchives({ root: temp, releaseManifest, env: {} });
  assert.deepEqual(calls, []);
});
