'use strict';

const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { realpathSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const expectedReply = 'PLANNING_GUI_FIRST_TURN_OK';

// Stand in for the signed-in account and its managed model service. The path
// from the desktop session bridge through the installed ACP program stays live.
async function createConversation({ app, client, runtime, workspace, scope, bridge }) {
  const host = require(path.join(client, 'main/agent-runtime/planning-host.cjs'));
  const context = require(path.join(client, 'main/conversation/requirement-context'));
  const key = randomBytes(24).toString('hex');
  const model = 'planning-e2e-model';
  const now = Math.floor(Date.now() / 1000);
  const claims = { typ: 'device', cid: scope.clientId, uid: scope.owner, iat: now, exp: now + 3600 };
  scope.session = Buffer.from(JSON.stringify(claims)).toString('base64url') + '.' + randomBytes(32).toString('hex');

  let session, selected, input, fixtureFailure;
  let modelCalls = 0, configurationCalls = 0;
  const hostCalls = { model: 0, commit: 0, other: 0, rejected: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, scope.hub);
    function json(status, value) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/v1/ai-proxy/config') {
        assert.equal(url.searchParams.get('agent'), selected);
        assert.ok(req.headers.authorization === 'Device ' + scope.session, 'Invalid fixture device authorization');
        configurationCalls++;
        return json(200, { ok: true, model, key, maxOutputTokens: 256 });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/ai-proxy/v1/chat/completions') {
        assert.ok(req.headers.authorization === 'Bearer ' + key, 'Invalid fixture model authorization');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks));
        assert.equal(request.model, model);
        assert.equal(request.stream, false);
        assert.ok(request.messages.some(row => row.role === 'user' && JSON.stringify(row.content).includes(input)),
          'The installed agent must forward the user message from the composer');
        assert.ok(request.messages.some(row => ['developer', 'system'].includes(row.role) &&
          JSON.stringify(row.content).includes('Planning Harness')), 'Missing installed Planning harness instructions');
        modelCalls++;
        return json(200, { model, object: 'chat.completion', id: 'fixture', created: now,
          choices: [{ index: 0, message: { role: 'assistant', content: expectedReply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      }
      json(404, { error: 'Unknown fixture route' });
    } catch (error) {
      fixtureFailure = error;
      json(500, { error: 'Unexpected fixture request' });
    }
  });
  // Offline Runner reconnects may probe the Hub websocket alongside local RPC.
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  scope.hub = 'http://127.0.0.1:' + server.address().port;
  const originalIdentity = context.cachedIdentity;
  context.cachedIdentity = currentApp => currentApp === app ? scope : originalIdentity(currentApp);
  runtime.onPlanningHost(async body => {
    hostCalls[['model', 'commit'].includes(body.method) ? body.method : 'other']++;
    try { return { ok: true, data: await host.request(body) }; }
    catch (error) {
      hostCalls.rejected++;
      return { ok: false, error: error.message };
    }
  });

  return {
    async send(adapterId, text, options = {}) {
      assert.equal(adapterId, 'ai-planning', 'The desktop must pass the selected runtime into the session');
      assert.ok(text && !text.includes(expectedReply), 'The user input must be distinct from the model reply');
      assert.equal(session, undefined, 'This check requires a fresh first turn');
      selected = adapterId;
      input = text;
      const draft = { ...options, adapterId, cwd: workspace };
      assert.notEqual(draft.accessMode, 'full', 'This first-turn scenario uses standard workspace permissions');
      const opening = require(path.join(client, 'main/conversation/work-conversation-opening'));
      const permitted = await opening.applyPolicy({ app, options: draft, cwd: workspace });
      assert.equal(permitted.ok, true, permitted.reason);
      const spec = require(path.join(client, 'main/conversation/session-spec')).build(draft, {}, { cwd: workspace });
      const opened = await bridge.open({ app, identity: scope, adapterId, cwd: spec.cwd, ref: 'chat-' + randomUUID(),
        readOnly: spec.readOnly, accessPolicy: spec.accessPolicy, intent: spec.intent,
        ...(typeof draft.modelName === 'string' ? { modelName: spec.modelName } : {}) });
      if (fixtureFailure) throw fixtureFailure;
      assert.equal(opened.ok, true, opened.reason);
      session = opened.session;
      assert.equal(session.adapterId, adapterId);
      assert.equal(session.snapshot().messages.length, 0);
      assert.equal(session.snapshot().accessPolicy.mode, draft.accessMode || (spec.readOnly ? 'readonly' : 'standard'));
      const turn = await session.send(text);
      if (fixtureFailure) throw fixtureFailure;
      if (!turn.ok) {
        const info = (await runtime.rpc('job.info', { ref: session.sessionId }).catch(() => null))?.data;
        const journal = (await runtime.rpc('job.session', { ref: session.sessionId, since: 0 }).catch(() => null))?.data;
        const items = journal?.items || [];
        // Counts only. Transcripts, signed tickets, absolute paths and native IDs stay private.
        throw Error('Planning first turn failed ' + JSON.stringify({
          configurationCalls, modelCalls, hostCalls, runtimeMatched: info?.cli === adapterId,
          nativeSessionCreated: Boolean(info?.cliSid), runnerStatus: ['queued', 'running', 'done', 'failed',
            'cancelled', 'stopped'].includes(journal?.status) ? journal.status : 'unknown',
          userRows: items.filter(row => row.kind === 'user').length,
          answerRows: items.filter(row => row.kind === 'say').length,
        }));
      }
      assert.ok(configurationCalls > 0, 'No managed model was requested for the chosen runtime');
      assert.equal(modelCalls, 1, 'The installed ACP agent must complete exactly one model request');
      const messages = session.snapshot().messages;
      assert.ok(messages.some(row => row.role === 'user' && row.text === text));
      const reply = messages.findLast(row => row.role === 'assistant');
      assert.equal(reply?.sourceAgent?.agentId, adapterId);
      const answer = reply.blocks.filter(block => block.kind === 'text').map(block => block.text).join('');
      assert.equal(answer, expectedReply);
      const info = await runtime.rpc('job.info', { ref: session.sessionId });
      assert.equal(info.ok, true, info.error);
      assert.equal(info.data.cli, adapterId);
      assert.ok(info.data.cliSid, 'The installed program did not return a native ACP session ID');
      assert.equal(realpathSync(info.data.workDir), realpathSync(workspace));
      return answer;
    },
    async close() {
      try { await session?.close(); }
      finally {
        context.cachedIdentity = originalIdentity;
        const closed = new Promise(resolve => server.close(resolve));
        server.closeAllConnections();
        await closed;
      }
    },
  };
}

module.exports = { createConversation, expectedReply };
