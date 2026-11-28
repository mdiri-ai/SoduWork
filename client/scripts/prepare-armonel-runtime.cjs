'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const manifest = require('../main/armonel-release.json');
const defaultRegistry = require('./armonel-npm-registry.json');
const { selectRelease, noticeNames } = require('../main/armonel-runtime.cjs');
const { replaceFileSync } = require('../main/verified-file-replace.cjs');
const { extractArchive, ensureArchive, downloadFile } = require('./prepare-node-runtime.cjs');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fileStat(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size > 0;
}

function verified(file, digest) {
  return fileStat(file) && sha256(file) === digest;
}

function checkArchive(archive, release, members) {
  if (!verified(archive, release.sha256)) {
    throw Error(`Armonel archive failed SHA-256 verification: ${release.file}`);
  }
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  const listed = spawnSync(tar, ['-tf', archive], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const names = (listed.stdout || '').trim().split(/\r?\n/).sort();
  if (listed.status !== 0 || names.length !== members.length || names.some((name, index) => name !== members[index])) {
    throw Error(`Unexpected archive members in ${release.file}`);
  }
}

function canExecute(platform, arch) {
  return platform === process.platform && (arch === process.arch ||
    (platform === 'darwin' && process.arch === 'arm64' && arch === 'x64'));
}

function verifyExecutable(file, release) {
  if (process.platform === 'darwin') {
    const cpu = release.target === 'darwin-arm64' ? 'arm64' : 'x86_64';
    const check = spawnSync('/usr/bin/lipo', ['-archs', file], { encoding: 'utf8', timeout: 15000 });
    if (check.status !== 0 || !check.stdout.trim().split(/\s+/).includes(cpu)) {
      throw Error(`Packaged Armonel does not contain the required macOS architecture: ${cpu}`);
    }
  }
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};
  const output = spawnSync(file, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000,
    cwd: path.dirname(file), env });
  if (output.status !== 0 || output.stdout?.trim() !== `armonel ${release.version}`) {
    throw Error(`Bundled ${release.target} Armonel must execute and report version ${release.version}: ${output.error?.message || output.stderr || output.status}`);
  }
}

function bundledArchive(root, release) {
  return path.join(root, 'runtime-packages', 'armonel', release.version, release.file);
}

async function cachedOrRemoteArchive(root, release, env, sourceExecutable) {
  const cache = path.join(root, '.runtime-cache', 'armonel');
  const named = path.join(cache, release.file);
  if (verified(named, release.sha256)) return named;
  const cached = path.join(cache, release.sha256);
  if (verified(cached, release.sha256)) return cached;
  const project = env.SODUWORK_ARMONEL_PROJECT_ID?.trim();
  const api = env.CI_API_V4_URL?.replace(/\/+$/, '');
  let npmRegistry = env.SODUWORK_ARMONEL_NPM_REGISTRY?.trim();
  let base = npmRegistry || env.SODUWORK_ARMONEL_PACKAGE_BASE_URL?.trim();
  if (!base && api && /^\d+$/.test(project || '')) base = api + '/projects/' + project + '/packages/generic/armonel-npm';
  const optionalDefault = !base && Boolean(sourceExecutable);
  if (!base) {
    if (project) throw Error('Armonel GitLab packages require a numeric project ID and CI_API_V4_URL');
    if (optionalDefault && verified(sourceExecutable, release.binary_sha256) &&
        noticeNames.every(name => fileStat(path.join(path.dirname(sourceExecutable), name)))) return null;
    npmRegistry = defaultRegistry;
    base = npmRegistry;
  }
  const url = new URL(base);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error('Invalid Armonel registry URL');
  const prefix = npmRegistry ? release.name + '/-' : release.version;
  url.pathname = url.pathname.replace(/\/+$/, '') + '/' + prefix + '/' + release.file;
  // Use the job token only for this GitLab API. Storage redirects receive no credentials.
  const get = (current, options, callback) => {
    if (!npmRegistry && env.CI_JOB_TOKEN && api && url.href.startsWith(api + '/') && String(current) === url.href) {
      options.headers['JOB-TOKEN'] = env.CI_JOB_TOKEN;
    }
    return https.get(current, options, callback);
  };
  try {
    return await ensureArchive({ sha256: release.sha256, urls: [url.href] }, cache, {
      download: (source, target) => downloadFile(source, target, { get, responseTimeoutMs: optionalDefault ? 15000 : undefined }),
    });
  } catch (error) {
    // A source desktop without access to the internal registry can still use other agents.
    const unavailable = ['ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED',
      'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error.code) ||
      ['Runtime download exceeded total time limit', 'Runtime download idle timeout'].includes(error.message);
    if (!optionalDefault || !unavailable) throw error;
    const concurrentArchive = [named, cached].find(file => verified(file, release.sha256));
    if (concurrentArchive) return concurrentArchive;
    if ([named, cached].some(file => fs.lstatSync(file, { throwIfNoEntry: false }))) {
      throw Error(`Armonel cached archive failed SHA-256 verification and the registry is unavailable: ${release.file}`, { cause: error });
    }
    console.warn(`[SoduWork Armonel runtime] Cannot reach the default registry for ${release.target} (${error.code || error.message}). Connect to the registry and restart to enable Armonel.`);
    return null;
  }
}

async function vendorArchives({ root = path.resolve(__dirname, '..'), env = process.env, releaseManifest = manifest } = {}) {
  for (const pkg of releaseManifest.packages.filter(entry => entry.target)) {
    const release = { ...pkg, version: releaseManifest.version };
    const target = bundledArchive(root, release);
    if (verified(target, release.sha256)) continue;
    const source = await cachedOrRemoteArchive(root, release, env);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const partial = target + '.' + crypto.randomUUID() + '.partial';
    try {
      fs.copyFileSync(source, partial, fs.constants.COPYFILE_EXCL);
      if (!verified(partial, release.sha256)) throw Error(`Armonel archive failed SHA-256 verification: ${release.file}`);
      replaceFileSync(partial, target);
    } finally {
      fs.rmSync(partial, { force: true });
    }
  }
}

async function prepare({ root = path.resolve(__dirname, '..'), platform = process.platform, arch = process.arch,
  env = process.env, sourceCheckout = false, archiveRoot = root } = {}) {
  const release = selectRelease(platform, arch);
  if (!release) return null;
  const runtime = path.join(root, '.runtime', 'armonel');
  const output = path.join(runtime, release.target);
  const executable = path.join(output, release.executable);
  const supplied = env.SODUWORK_ARMONEL_PACKAGE?.trim();
  let archive = supplied ? path.resolve(supplied) : bundledArchive(archiveRoot, release);
  if (!supplied && !fs.lstatSync(archive, { throwIfNoEntry: false })) {
    archive = await cachedOrRemoteArchive(root, release, env, sourceCheckout ? executable : undefined);
  }
  if (!archive) {
    if (!fs.lstatSync(executable, { throwIfNoEntry: false })) return null;
    if (!verified(executable, release.binary_sha256) || !noticeNames.every(name => fileStat(path.join(output, name)))) {
      throw Error(`Invalid staged Armonel runtime. Provide ${release.file} or set SODUWORK_ARMONEL_NPM_REGISTRY to repair it.`);
    }
    if (canExecute(platform, arch)) verifyExecutable(executable, release);
    return output;
  }
  const members = ['package/package.json', `package/bin/${release.executable}`,
    ...noticeNames.map(name => 'package/' + name)].sort();
  fs.mkdirSync(runtime, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(runtime, '.stage-'));
  try {
    const input = path.join(temporary, release.file);
    fs.copyFileSync(archive, input, fs.constants.COPYFILE_EXCL);
    checkArchive(input, release, members);
    extractArchive(input, temporary);
    if (!members.every(name => fileStat(path.join(temporary, name)))) throw Error('Invalid Armonel payload files');
    const pkg = JSON.parse(fs.readFileSync(path.join(temporary, 'package/package.json'), 'utf8'));
    if (pkg.name !== release.name || pkg.version !== release.version || pkg.license !== 'MIT' ||
        pkg.os?.join(',') !== platform || pkg.cpu?.join(',') !== arch) throw Error('Unexpected Armonel package metadata');
    const executable = path.join(temporary, 'package', 'bin', release.executable);
    if (!verified(executable, release.binary_sha256)) throw Error('Armonel executable failed SHA-256 verification');
    if (canExecute(platform, arch)) verifyExecutable(executable, release);
    fs.mkdirSync(output, { recursive: true });
    for (const name of noticeNames) {
      const source = path.join(temporary, 'package', name);
      if (!verified(path.join(output, name), sha256(source))) replaceFileSync(source, path.join(output, name));
    }
    const target = path.join(output, release.executable);
    if (!verified(target, release.binary_sha256)) replaceFileSync(executable, target);
    if (process.platform !== 'win32' && platform !== 'win32') fs.chmodSync(target, 0o755);
    console.log(`[SoduWork Armonel runtime] ${release.version} verified and staged for ${release.target}`);
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [mode, checkoutClient] = process.argv.slice(2);
  const run = mode === '--vendor' ? vendorArchives() : prepare({
    sourceCheckout: mode === '--source',
    archiveRoot: mode === '--source' && checkoutClient ? path.resolve(checkoutClient) : undefined,
  });
  run.catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { prepare, vendorArchives, verifyExecutable, canExecute };
