'use strict';

const TLS_HANDSHAKE_GRACE_MS = 2500;
let dispatcher;

function createDispatcher() {
  const { Agent, buildConnector } = require('undici');
  const connect = buildConnector({});
  const connectWithSmallerHello = buildConnector({ ecdhCurve: 'X25519:prime256v1' });

  return new Agent({ connect(options, callback) {
    if (options.protocol !== 'https:') return connect(options, callback);

    let pending = 1;
    let settled = false;
    let timer;
    let fallback;
    function finish(error, connected) {
      if (settled) return;
      pending--;
      if (error && pending > 0) return;
      settled = true;
      clearTimeout(timer);
      for (const socket of [primary, fallback]) {
        if (socket && socket !== connected && !socket.destroyed) {
          socket.destroy(new Error('Another TLS handshake completed first'));
        }
      }
      callback(error, connected);
    }

    const primary = connect(options, finish);
    // Let slow handshakes finish while a smaller ClientHello races the original.
    // Undici receives one socket, after certificate validation on that socket.
    primary.once('connect', () => {
      timer = setTimeout(() => {
        pending++;
        try { fallback = connectWithSmallerHello(options, finish); }
        catch (error) { finish(error); }
      }, TLS_HANDSHAKE_GRACE_MS);
      timer.unref();
    });
  } });
}

function fetchHubAuth(url, options) {
  // Leave an explicitly configured Node proxy on the default dispatcher.
  const useEnvProxy = process.env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy') ||
    /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS || '');
  if (!url.startsWith('https://') || useEnvProxy) return global.fetch(url, options);
  dispatcher ||= createDispatcher();
  return global.fetch(url, { ...options, dispatcher });
}

module.exports = fetchHubAuth;
