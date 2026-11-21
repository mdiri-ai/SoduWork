'use strict';

// Source startup runs this in a dedicated download child, never the desktop or
// model runtime. Resolve the same undici as the locked @electron/get package.
const path = require('node:path');
const { createRequire } = require('node:module');

function installElectron({ installer = path.join(__dirname, '../node_modules/electron/install.js'),
  env = process.env, requireFrom = createRequire } = {}) {
  const install = requireFrom(installer);
  const switchValue = String(env.ELECTRON_GET_USE_PROXY || '').trim().toLowerCase();
  const useProxy = !['', '0', 'false', 'no', 'off'].includes(switchValue);
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
  catch (error) {
    // #883: a bare "TypeError: fetch failed" hid the real reason. Surface the
    // swallowed cause plus mirror/proxy state and a copyable retry hint.
    console.error(error && error.message ? error.message : String(error));
    const hints = {
      ENOTFOUND: '域名解析失败（DNS），检查网络或内网 DNS / DNS lookup failed',
      EAI_AGAIN: '域名解析暂时失败（DNS），稍后重试 / Temporary DNS failure, retry later',
      ETIMEDOUT: '连接超时，网络不稳定或目标不可达 / Connection timed out',
      ECONNRESET: '连接被重置，重试通常可恢复 / Connection reset, retrying often helps',
      ECONNREFUSED: '连接被拒，代理未启动或端口不对 / Connection refused, check your proxy',
      CERT_HAS_EXPIRED: '证书过期，检查系统时间或代理拦截 / Certificate expired',
      UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书校验失败，可能是代理拦截 / Certificate verification failed',
    };
    const codes = [];
    const collect = (node, depth = 0) => {
      if (!node || depth > 3) return;
      if (node.code) codes.push(String(node.code));
      if (node.cause) collect(node.cause, depth + 1);
      if (Array.isArray(node.errors)) for (const item of node.errors) collect(item, depth + 1);
    };
    collect(error && error.cause);
    for (const code of [...new Set(codes)]) {
      console.error(`- ${code}: ${hints[code] || '网络错误 / network error'}`);
    }
    const mirror = process.env.ELECTRON_MIRROR;
    console.error(`ELECTRON_MIRROR: ${mirror || '(not set; default github.com releases / 未设置，默认官方源)'}`);
    const proxyVars = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ELECTRON_GET_USE_PROXY']
      .filter((key) => process.env[key])
      .map((key) => `${key}=${process.env[key]}`);
    console.error(`Proxy env / 代理变量: ${proxyVars.length ? proxyVars.join(', ') : '(none; direct connection / 未设置，直连)'}`);
    console.error('Retry with a mirror, then rerun the same launcher command / 设置镜像后重试同一启动命令:');
    console.error('  PowerShell: $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"');
    console.error('  bash: export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/');
    process.exitCode = 1;
  }
}

module.exports = { installElectron };
