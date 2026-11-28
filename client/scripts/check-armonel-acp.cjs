'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { version } = require('../main/armonel-release.json');

// Exercise the executable copied into the installer with a deterministic offline model.
async function checkAcp(executable) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'soduwork-acp-'));
  try {
    const work = path.join(root, 'workspace');
    await fs.mkdir(work);
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, { HOME: root, USERPROFILE: root });
    const child = spawn(executable, ['--data', path.join(root, 'data'), 'acp', '--workspace', work,
      '--mock', '--no-memory', '--read-only'], { cwd: work, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let id = 0, sessionId, answered = false, finished = false, failure, stderr = '';
      function fail(error) { failure ||= error; child.kill(); }
      const timer = setTimeout(() => fail(Error('ACP check timed out')), 30000);
      function send(method, params) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
      }
      child.stdin.on('error', fail);
      child.on('error', fail);
      child.stderr.on('data', data => { stderr = (stderr + data).slice(-1024); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failure || !finished || code !== 0) reject(failure || Error(`Armonel ACP exited (${code}): ${stderr}`));
        else resolve();
      });
      createInterface({ input: child.stdout }).on('line', line => {
        try {
          const msg = JSON.parse(line);
          if (msg.method === 'session/update') {
            const { update } = msg.params;
            if (msg.params.sessionId === sessionId && update.sessionUpdate === 'agent_message_chunk' &&
                update.content?.type === 'text' && update.content.text.trim()) answered = true;
            return;
          }
          if (msg.id !== id || !msg.result) throw Error(`Unexpected ACP response for step ${id}: ${msg.error?.message || 'invalid response'}`);
          switch (id) {
            case 1:
              if (msg.result.protocolVersion !== 1 || msg.result.agentInfo?.name !== 'armonel' ||
                  msg.result.agentInfo.version !== version) throw Error('Invalid bundled Armonel version or ACP handshake');
              send('session/new', { cwd: work, mcpServers: [] });
              break;
            case 2:
              sessionId = msg.result.sessionId;
              if (!sessionId) throw Error('ACP returned no session ID');
              send('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Hello' }] });
              break;
            case 3:
              if (!answered || msg.result.stopReason !== 'end_turn') throw Error('ACP prompt finished without a reply');
              send('session/close', { sessionId });
              break;
            case 4:
              finished = true;
              child.stdin.end();
              break;
          }
        } catch (error) { fail(error); }
      });
      send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
module.exports = { checkAcp };
