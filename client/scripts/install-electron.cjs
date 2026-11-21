'use strict';

// Source startup runs this in a dedicated download child, never the desktop or
// model runtime. Resolve the same undici as the locked @electron/get package.
const path = require('node:path');
const { createRequire } = require('node:module');
const { channel } = require('node:diagnostics_channel');

// Observe the locked installer's actual requests, including a failure while
// reading the body. Keep proxy addresses and signed URL parameters out of logs.
function observeDownloads(env, useProxy) {
  const setting = key => (env[key.toLowerCase()] ?? env[key]) ? 'set' : 'unset';
  console.error(`Electron proxy mode: ${useProxy ? 'environment' : 'disabled'} ` +
    `(HTTP_PROXY=${setting('HTTP_PROXY')}, HTTPS_PROXY=${setting('HTTPS_PROXY')}, NO_PROXY=${setting('NO_PROXY')})`);
  if (useProxy) {
    channel('undici:request:create').subscribe(({ request }) => {
      if (request.method === 'CONNECT') console.error('Electron route: requesting a proxy tunnel');
    });
  }
  const reported = new Set();
  function report(error) {
    if (!error) return;
    const proxyStatus = /Proxy response \((\d{3})\)/i.exec(error.message || '');
    const code = proxyStatus ? 'PROXY_HTTP_' + proxyStatus[1] : error.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) && !reported.has(code)) {
      reported.add(code);
      console.error('Electron transport: ' + code);
    }
    if (error.cause) report(error.cause);
    if (Array.isArray(error.errors)) error.errors.forEach(report);
  }
  channel('undici:request:error').subscribe(({ error }) => report(error));
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    const official = url.origin === 'https://github.com' && /^\/electron\/(electron|nightlies)\/releases\/download\//.test(url.pathname);
    console.error(`Electron source: ${official ? 'official' : 'mirror'} ${url.origin}${url.pathname} ` +
      `(ELECTRON_MIRROR=${env.ELECTRON_MIRROR ? 'set' : 'unset'})`);
    if (url.username || url.password) throw new Error('Electron download URL contains unsupported credentials.');
    let response;
    try {
      response = await fetch(input, options);
    } catch (error) {
      report(error);
      throw error;
    }
    if (!response.ok) {
      // The upstream HTTPError includes the complete, potentially signed redirect URL.
      throw new Error('Electron HTTP status: ' + response.status);
    }
    return response;
  };
}

function installElectron({ installer = path.join(__dirname, '../node_modules/electron/install.js'),
  env = process.env, requireFrom = createRequire } = {}) {
  const install = requireFrom(installer);
  const switchValue = String(env.ELECTRON_GET_USE_PROXY || '').trim().toLowerCase();
  const useProxy = !['', '0', 'false', 'no', 'off'].includes(switchValue);
  if (require.main === module) observeDownloads(env, useProxy);
  if (env.ELECTRON_GET_USE_PROXY !== undefined) env.ELECTRON_GET_USE_PROXY = '';
  if (useProxy) {
    let proxy;
    try {
      const fromGet = requireFrom(install.resolve('@electron/get'));
      proxy = fromGet('undici');
      if (typeof proxy.EnvHttpProxyAgent !== 'function' || typeof proxy.setGlobalDispatcher !== 'function') {
        throw new Error('Unsupported proxy dependency');
      }
    } catch (_) {
      // @electron/get's optional proxy initialization logs and then goes direct.
      // Fail before its installer runs instead of ignoring the selected proxy.
      throw new Error('Electron proxy support is unavailable. Run npm ci in client/ and retry.');
    }
    try {
      proxy.setGlobalDispatcher(new proxy.EnvHttpProxyAgent());
    } catch (_) {
      throw new Error('Electron proxy configuration is invalid. Check HTTP_PROXY and HTTPS_PROXY, then retry.');
    }
  }
  // The dispatcher is already installed, or the user opted out. Keep the
  // downloader from running its silent optional-dependency fallback below.
  return install(installer);
}

if (require.main === module) {
  try { installElectron(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { installElectron };
