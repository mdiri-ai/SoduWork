'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const host = require('../main/agent-runtime/planning-host.cjs');
const config = require('../main/agent-runtime/runner-config.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('management forwards only Planning operations from the desktop under the active owner', async () => {
  let handle, owner = 'alice';
  const calls = [], key = 'ai-planning', jobId = 'abc123abc123';
  const frame = {};
  const sender = { getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href,
    isDestroyed: () => false, mainFrame: frame };
  const event = { sender, senderFrame: frame };
  require('../main/agent-runtime/planning-management.cjs').install({
    ipcMain: { handle: (_channel, fn) => { handle = fn; } },
    scopeOf: () => ({ hub: 'https://fixture.invalid', clientId: 'device', owner }),
    runner: { rpc: async (op, packet) => {
      calls.push({ op, packet });
      return { ok: true, data: op === 'agent.install' ? { jobId } : { key, installed: false } };
    } },
  });
  const status = await handle(event, { action: 'status' });
  assert.equal(status.agent.installed, false);
  assert.deepEqual(calls[0], { op: 'runtime.detect', packet: { key } });
  for (const action of ['install', 'check', 'update', 'uninstall']) {
    assert.deepEqual(await handle(event, { action, owner: status.owner }), { jobId });
    assert.deepEqual(calls.at(-1), { op: 'agent.install', packet: { key, action, ownerId: status.owner } });
  }
  await handle(event, { action: 'job', owner: status.owner, jobId });
  assert.deepEqual(calls.at(-1), { op: 'agent.job', packet: { jobId, ownerId: status.owner } });
  await assert.rejects(handle({ sender, senderFrame: {} }, { action: 'status' }), /工作台/);
  await assert.rejects(handle(event, { action: 'login', owner: status.owner }), /无效/);
  owner = 'bob';
  await assert.rejects(handle(event, { action: 'uninstall', owner: status.owner }), /账号/);
  assert.equal(calls.length, 6);
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-acp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'work'); fs.mkdirSync(cwd);
  const app = { getPath: () => dir, getAppPath: () => dir };
  const identity = { hub: 'https://hub.example', clientId: 'desktop', session: 'owner-session' };
  const model = { id: 'managed-business', baseUrl: identity.hub + '/api/v1/ai-proxy/v1', key: 'model-secret',
    quotaUsageToken: 'quota-secret', maxOutputTokens: 1024 };
  const options = { app, cwd, identity, runId: 'runner-ref', operation: 'turn-1', input: 'monthly report', policy: { revision: 1 },
    currentIdentity: () => identity, model };
  const issue = extra => {
    const access = host.issue({ ...options, ...extra });
    t.after(access.revoke);
    const request = (method, params = {}, overrides = {}) => host.request({
      grant: access.config.planningHostGrant, workspace: cwd, runId: options.runId, method, params: {
        sessionId: 'acp-session', executionId: access.config.planningExecutionId, callId: 'call-1', ...params }, ...overrides });
    return { ...access, request };
  };
  return { dir, cwd, app, identity, model, options, issue };
}
test('Planning authorizes alternate Windows spellings of the same workspace', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const alias = path.join(f.dir, 'WORK');
  if (!fs.existsSync(alias)) return t.skip('The temporary directory is case-sensitive');
  const access = f.issue({ cwd: alias });
  fs.writeFileSync(path.join(f.cwd, 'input.txt'), 'fixture');
  const read = { operation: 'read', path: 'input.txt' };
  assert.deepEqual(await access.request('fs.authorize', read), { authorized: true });
  await assert.rejects(access.request('fs.authorize', read, { workspace: f.dir }), /工作区与本机授权不匹配/);
});

test('Planning tickets stay in Electron and only the issued model endpoint receives a request', async t => {
  const f = fixture(t); let called = 0, usage;
  const access = f.issue({ onUsage: u => { usage = u; }, fetchImpl: async (url, options) => {
    called++;
    assert.equal(url, f.model.baseUrl + '/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer model-secret');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, f.model.id); assert.equal(body.max_tokens, 1024); assert.equal(body.stream, false);
    assert.equal(body.base_url, undefined);
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 8, completion_tokens: 2 } });
  } });
  assert.throws(() => config.create(f.model, 'ai-planning'), /本机受管/);
  assert.doesNotMatch(JSON.stringify(config.create(f.model, 'ai-planning', [], access.config)), /model-secret|quota-secret|hub.example/);
  const params = { request: { messages: [{ role: 'user', content: 'report' }], base_url: 'https://wrong.example',
    model: 'other', max_tokens: 2048 } };
  assert.equal((await access.request('model', params)).choices[0].message.content, 'done');
  assert.equal(called, 1); assert.equal(usage.model.quotaUsageToken, f.model.quotaUsageToken);
  await assert.rejects(access.request('model', params), /已使用/);
  await assert.rejects(access.request('model', { ...params, callId: '2', sessionId: 'unrelated' }), /当前会话/);
  await assert.rejects(access.request('model', params, { grant: 'wrong' }), /授权/);
  await assert.rejects(access.request('model', params, { runId: 'wrong' }), /执行不匹配/);
  await assert.rejects(access.request('model', params, { workspace: f.dir }), /工作区/);
  access.revoke(); await assert.rejects(access.request('model', params), /失效/);
  assert.throws(() => f.issue({ model: { ...f.model, localOnly: true } }), /企业模型/);
});
test('commit verifies real files and persists one receipt per execution, rejecting drift and cross-owner reuse', async t => {
  const f = fixture(t);
  const a = f.issue();
  fs.writeFileSync(path.join(f.cwd, 'report.txt'), 'accepted');
  fs.writeFileSync(path.join(f.dir, 'private.txt'), 'secret');
  const params = { summary: 'done', artifacts: [{ path: 'report.txt', sha256: hash('accepted') }] };
  const receipt = await a.request('commit', params);
  assert.deepEqual(await a.request('commit', params), receipt);
  await assert.rejects(a.request('commit', { ...params, summary: 'changed' }), /冲突/);
  await assert.rejects(a.request('commit', { ...params, artifacts: [{ path: '../private.txt', sha256: hash('secret') }] }), /超出/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(f.dir, 'private.txt'), path.join(f.cwd, 'link'));
    await assert.rejects(a.request('commit', { artifacts: [{ path: 'link', sha256: hash('secret') }] }), /超出/);
  }
  a.revoke();
  const b = f.issue();
  assert.equal(b.config.planningExecutionId, a.config.planningExecutionId);
  assert.notEqual(b.config.planningHostGrant, a.config.planningHostGrant);
  assert.deepEqual(await b.request('commit', params), receipt);
  assert.equal((await b.request('commit', { callId: 'text-only', artifacts: [] })).artifacts.length, 0);
  fs.writeFileSync(path.join(f.cwd, 'report.txt'), 'changed');
  await assert.rejects(b.request('commit', params), /校验失败/);
  assert.notEqual(f.issue({ input: 'different' }).config.planningExecutionId, b.config.planningExecutionId);
  f.identity.session = 'signed-out-or-other-account';
  await assert.rejects(b.request('commit', params), /失效/);
});
test('workbook authorization checks the active identity, file type, workspace and current write policy', async t => {
  const f = fixture(t);
  let policy = { mode: 'standard', revision: 1 };
  const a = f.issue({ policy, currentPolicy: () => policy });
  assert.deepEqual(await a.request('workbook.authorize', { operation: 'write', sha256: hash('spec'), path: 'report.xlsx' }), { authorized: true });
  await assert.rejects(a.request('workbook.authorize', { operation: 'write', sha256: hash('spec'), path: 'report.xlsx.exe' }), /路径/);
  await assert.rejects(a.request('workbook.authorize', { operation: 'write', sha256: hash('spec'), path: '../report.xlsx' }), /工作区/);
  policy = { mode: 'readonly', revision: 2 };
  await assert.rejects(a.request('workbook.authorize', { operation: 'write', sha256: hash('spec'), path: 'report.xlsx' }), /权限/);
  const b = f.issue({ policy });
  fs.writeFileSync(path.join(f.cwd, 'existing.xlsx'), 'bytes');
  assert.deepEqual(await b.request('workbook.authorize', { operation: 'read', path: 'existing.xlsx' }), { authorized: true });
  assert.deepEqual(await b.request('workbook.authorize', { operation: 'read', path: '.soduwork-inputs-' + '0'.repeat(24) + '/archived.xlsx' }), { authorized: true });
  assert.deepEqual(await b.request('fs.authorize', { operation: 'read', path: 'existing.xlsx' }), { authorized: true });
  await assert.rejects(b.request('fs.authorize', { operation: 'write', sha256: hash('hello'), path: 'report.txt' }), /授权/);
  await assert.rejects(b.request('workbook.authorize', { operation: 'write', sha256: hash('spec'), path: 'report.xlsx' }), /授权/);
});

test('only a retryable Planning probe can recover during a catalog refresh', async () => {
  const { createRunnerRuntimeAdapter } = require('../main/agent-runtime/runner-adapter');
  const catalog = require('../main/agent-runtime/runtime-catalog').loadCatalog();
  const busy = { ok: false, code: 'RUNNER_RPC_BUSY', retryable: true, uncertain: false };
  for (const [id, first, expectedCalls] of [
    ['ai-planning', busy, 2],
    ['ai-planning', { ...busy, uncertain: true }, 1],
    ['ai-planning', { ...busy, retryable: false }, 1],
    ['ai-planning', { ...busy, code: 'RUNNER_STOPPED' }, 1],
    ['codex', busy, 1],
  ]) {
    let calls = 0;
    const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(id),
      runnerRuntime: { async rpc(op, packet) {
        assert.equal(op, 'runtime.detect');
        assert.equal(packet.key, id);
        return ++calls === 1 ? first : { ok: true, data: { installed: true, state: 'ready' } };
      } },
    });
    assert.equal((await adapter.detect()).ok, expectedCalls === 2);
    assert.equal(calls, expectedCalls);
  }
});

test('the conversation adapter issues distinct scoped grants on dispatch and continuation, then revokes each', async t => {
  const f = fixture(t);
  const adapterId = 'ai-planning', alias = 'planning-contract';
  const { createRunnerRuntimeAdapter, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
  const runtimeSpec = require('../main/agent-runtime/runtime-catalog').loadCatalog().runtime(adapterId);
  const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':' + adapterId);
  t.mock.method(require('../main/conversation/requirement-context'), 'cachedIdentity', () => f.identity);
  const grants = [], roles = [];
  let probeCalls = 0;
  const adapter = createRunnerRuntimeAdapter({ app: f.app, runtimeSpec,
    modelConfig: { fetchModel: async (_identity, _name, _timeout, _fetch, _force, id, options) => {
      roles.push(id); assert.equal(options.allowLocal, false);
      return { ok: true, model: f.model };
    } },
    runnerRuntime: { async rpc(op, packet) {
      if (op === 'runtime.detect') {
        if (++probeCalls === 1) return { ok: false, code: 'RUNNER_RPC_BUSY', retryable: true, uncertain: false };
        return { ok: true, data: { accessControl: runtimeSpec.accessControl } };
      }
      if (op === 'job.dispatch' || op === 'job.comment') {
        const cfg = packet.cfg;
        assert.deepEqual(cfg.llm, { model: f.model.id });
        assert.equal(cfg.accessPolicy.mode, 'standard');
        assert.doesNotMatch(JSON.stringify(packet), /model-secret|quota-secret/);
        const request = () => host.request({ method: 'commit', runId: ref, grant: cfg.planningHostGrant, workspace: f.cwd,
          params: { sessionId: 'session', executionId: cfg.planningExecutionId, callId: 'deliver', artifacts: [] } });
        assert.ok((await request()).receiptId);
        grants.push({ cfg, request }); return { ok: true, data: { ok: true, ref } };
      }
      if (op === 'job.session') return { ok: true, data: { status: 'done', round: grants.length,
        items: [{ seq: grants.length, kind: 'say', text: 'done' }] } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw Error(op);
    } },
  });
  const session = await adapter.createSession({ runtimeId: adapterId, identity: f.identity,
    native: { runner: { openOptions: { ref: alias, cwd: f.cwd } } } });
  t.after(() => session.dispose());
  for (const text of ['first', 'second']) {
    const result = await session.send({ text }).completion;
    assert.equal(result.ok, true, result.reason || 'turn failed');
    await assert.rejects(grants.at(-1).request(), /失效/);
  }
  assert.equal(probeCalls, 2);
  assert.deepEqual([...new Set(roles)], [adapterId]);
  assert.notEqual(grants[0].cfg.planningExecutionId, grants[1].cfg.planningExecutionId);
});

test('negotiated model stream preserves UTF-8, multiline SSE, tool fields, sequence and exactly one usage receipt', async t => {
  const f = fixture(t);
  const content = 'data: {"choices":[{"index":0,\r\ndata: "delta":{"content":"中"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n' +
    'data: [DONE]\n\n';
  const bytes = Buffer.from(content); let calls = 0, index = 0;
  const receipts = [];
  const a = f.issue({ model: { ...f.model, capabilityProfile: { streaming: { state: 'supported' } }, compatibility: { streamOptions: true } },
    onUsage: receipt => receipts.push(receipt), fetchImpl: async (_, options) => {
      calls++; const body = JSON.parse(options.body);
      assert.equal(body.stream, true); assert.equal(body.stream_options.include_usage, true);
      return new Response(new ReadableStream({ pull(controller) {
        if (index === bytes.length) controller.close(); else controller.enqueue(bytes.subarray(index, ++index));
      } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    } });
  assert.equal(a.config.planningModelStream, true);
  const call = (method, extra = {}) => a.request('model.' + method, extra);
  assert.deepEqual(await call('start', { request: { messages: [{ role: 'user', content: 'message' }] } }), { started: true });
  await assert.rejects(call('next', { seq: 4 }), /序号/);
  assert.equal((await call('next', { seq: 0 })).chunks[0].choices[0].delta.content, '中');
  assert.equal((await call('next', { seq: 1 })).chunks[0].choices[0].delta.tool_calls[0].function.arguments, '{}');
  assert.deepEqual((await call('next', { seq: 2 })).chunks[0].usage, { prompt_tokens: 9, completion_tokens: 4 });
  assert.deepEqual(await call('next', { seq: 3 }), { done: true, chunks: [] });
  assert.deepEqual(await call('close'), { closed: true });
  assert.equal(calls, 1); assert.equal(receipts.length, 1);
});

test('stream opt-in requires declared model support and accepts a single non-streaming response from the same request', async t => {
  const f = fixture(t);
  const request = { messages: [{ role: 'user', content: 'hello' }] };
  const unnegotiated = f.issue({ fetchImpl: async () => { throw Error('unexpected'); } });
  assert.equal(unnegotiated.config.planningModelStream, undefined);
  await assert.rejects(unnegotiated.request('model.start', { request }), /不可用/);
  let calls = 0;
  const a = f.issue({ model: { ...f.model, capabilityProfile: { streaming: { state: 'supported' } } }, fetchImpl: async () => {
    calls++; return Response.json({ choices: [{ message: { role: 'assistant', content: 'whole' } }] });
  } });
  assert.equal((await a.request('model.start', { request })).completion.choices[0].message.content, 'whole');
  await assert.rejects(a.request('model.next', { seq: 0 }), /状态/);
  assert.equal(calls, 1);
});

test('revoking a stream releases a blocked provider reader and rejects late data', async t => {
  const f = fixture(t); let cancelled = 0, startRead;
  const waiting = new Promise(resolve => { startRead = resolve; });
  const a = f.issue({ model: { ...f.model, capabilityProfile: { streaming: { state: 'supported' } } },
    fetchImpl: async () => new Response(new ReadableStream({ pull() { startRead(); }, cancel() { cancelled++; } },
      { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }) });
  await a.request('model.start', { request: { messages: [{ role: 'user', content: 'hello' }] } });
  const pull = a.request('model.next', { seq: 0 });
  await waiting; a.revoke();
  await assert.rejects(pull); assert.equal(cancelled, 1);
  await assert.rejects(a.request('model.next', { seq: 0 }), /失效/);
});

test('provider error frames, oversized frames and truncated streams cannot complete an ACP model call', async t => {
  const f = fixture(t);
  for (const text of ['data: {"error":{"message":"private message"}}\n\n', 'data: ' + 'x'.repeat(128 * 1024),
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n']) {
    const a = f.issue({ model: { ...f.model, capabilityProfile: { streaming: { state: 'supported' } } },
      fetchImpl: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }) });
    await a.request('model.start', { request: { messages: [{ role: 'user', content: 'hello' }] } });
    await assert.rejects(async () => {
      for (let seq = 0; seq < 2; seq++) await a.request('model.next', { seq });
    }, /模型(事件过大|流返回错误|流中断)/);
  }
});

test('a settled Planning response enqueues one attributed desktop usage event without returning its billing ticket', async t => {
  const f = fixture(t), sent = [];
  const now = Math.floor(Date.now() / 1000);
  f.identity.session = Buffer.from(JSON.stringify({ typ: 'device', uid: 'test-account', cid: f.identity.clientId,
    iat: now - 5, exp: now + 3600 })).toString('base64url') + '.' + 'b'.repeat(64);
  const reporter = require('../main/agent-runtime/usage-reporter').createUsageReporter({ app: f.app,
    identityOf: async () => f.identity, fetchImpl: async (_url, options) => {
      sent.push(JSON.parse(options.body)); return Response.json({ ok: true });
    } });
  host.setUsageListener(reporter.recordPlanning);
  t.after(() => host.setUsageListener(null));
  const a = f.issue({ fetchImpl: async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 8, completion_tokens: 2 } }) });
  const response = await a.request('model', { request: { messages: [{ role: 'user', content: 'a' }] } });
  assert.doesNotMatch(JSON.stringify(response), /quota-secret|model-secret/);
  await reporter.persist(); await reporter.flush(); await reporter.flush();
  assert.equal(sent.length, 1); assert.equal(sent[0].agent, 'ai-planning');
  assert.equal(sent[0].quotaUsageToken, f.model.quotaUsageToken);
  assert.equal(sent[0].usage.total, 10); assert.equal(sent[0].conversationId, f.options.runId);
});
