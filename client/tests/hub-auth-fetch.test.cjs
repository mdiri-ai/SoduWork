'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const deviceAuth = require('../main/device-auth');
const fetchHubAuth = require('../main/hub-auth-fetch.cjs');
const { createSafeStorage } = require('./helpers/device-safe-storage-fixture.cjs');
const { certificate } = require('./helpers/tls-fixture.cjs');

async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

function forward(socket, port) {
  const upstream = net.connect(port, '127.0.0.1');
  socket.on('close', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
}

test('desktop password login recovers from a stalled TLS handshake without replaying its POSTs', async t => {
  const requests = [];
  const material = certificate();
  const server = https.createServer(material, async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, path: request.url, deviceKey: request.headers['x-device-key'],
      body: JSON.parse(Buffer.concat(chunks)), tls: request.socket.getProtocol() });
    const payload = request.url.endsWith('/clients/enroll') ? { activationRequired: true } : {
      session: 'fixture-session', expiresIn: 300, user: { id: 'fixture-owner' },
    };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(payload));
  });
  const serverPort = await listen(t, server);
  let connections = 0;
  const gateway = net.createServer(socket => {
    if (++connections === 1) { socket.resume(); return; }
    forward(socket, serverPort);
  });
  const gatewayPort = await listen(t, gateway);
  const attempts = [];
  const connect = tls.connect;
  t.mock.method(tls, 'connect', options => {
    const socket = connect({ ...options, ca: material.cert });
    attempts.push({ curve: options.ecdhCurve, socket });
    return socket;
  });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-auth-tls-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const app = { getPath: () => profile };
  deviceAuth.install({ app, ipcMain: { handle() {} }, safeStorage: createSafeStorage() });
  const result = await deviceAuth.accountAction(app, {
    action: 'password', hub: `https://127.0.0.1:${gatewayPort}`, account: 'fixture-owner', password: 'fixture-only',
  });

  assert.equal(result.ok, true, result.error);
  assert.equal(result.session, 'fixture-session');
  assert.deepEqual(attempts.slice(0, 2).map(attempt => attempt.curve), [undefined, 'X25519:prime256v1']);
  assert.equal(attempts.filter(attempt => attempt.curve).length, 1);
  assert.ok(attempts[0].socket.destroyed);
  assert.deepEqual(requests.map(row => [row.method, row.path, row.tls]), [
    ['POST', '/api/v1/clients/enroll', 'TLSv1.3'], ['POST', '/api/v1/client-auth/login/password', 'TLSv1.3'],
  ]);
  assert.equal(requests[0].body.device, result.clientId);
  assert.ok(requests[0].deviceKey);
  assert.equal(requests[1].deviceKey, requests[0].deviceKey);
  assert.equal(requests[1].body.password, 'fixture-only');
});

test('a slow default TLS handshake can still complete within the enrollment deadline', async t => {
  const requests = [];
  const material = certificate();
  const server = https.createServer(material, (request, response) => {
    requests.push([request.method, request.url]);
    request.resume();
    response.end('{}');
  });
  const serverPort = await listen(t, server);
  const gateway = net.createServer(socket => {
    const timer = setTimeout(() => forward(socket, serverPort), 6000);
    socket.once('close', () => clearTimeout(timer));
  });
  const gatewayPort = await listen(t, gateway);
  const connect = tls.connect;
  const attempts = [];
  t.mock.method(tls, 'connect', options => {
    const socket = connect({ ...options, ca: material.cert });
    attempts.push({ curve: options.ecdhCurve, socket });
    return socket;
  });

  const enrollmentPath = '/api/v1/clients/enroll';
  const response = await fetchHubAuth(`https://127.0.0.1:${gatewayPort}${enrollmentPath}`, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(requests, [['POST', enrollmentPath]]);
  assert.deepEqual(attempts.map(attempt => attempt.curve), [undefined, 'X25519:prime256v1']);
  assert.ok(attempts[1].socket.destroyed);
});

test('an untrusted Hub certificate fails before credentials are sent and without retry', async t => {
  let connections = 0;
  const server = https.createServer(certificate(), () => assert.fail('Sent credentials to an untrusted Hub'));
  server.on('connection', () => connections++);
  const port = await listen(t, server);
  await assert.rejects(fetchHubAuth(`https://127.0.0.1:${port}/login`, {
    method: 'POST', body: '{}', signal: AbortSignal.timeout(6000),
  }), error => error.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(connections, 1);
});
