'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRunnerRuntimeAdapter, getRunnerSessionDetails, _uuidV5 } = require('../main/agent-runtime/runner-adapter');
const catalog = require('../main/agent-runtime/runtime-catalog'), native = require('../main/agent-runtime/native-model-catalog');

for (const agentId of ['qwen', 'codex']) test(agentId + ' sends provider model IDs and matching reasoning config only when changing execution', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-contract-'));
  const alias = 'switch-contract', ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':' + agentId);
  const calls = []; let turn = 0, accepted;
  const old = native.list; native.list = () => ({ models: ['a', 'b', 'c'].map(id => ({ id,
    reasoningLevels: ['low', 'medium', 'high'], defaultReasoning: 'medium' })) });
  t.after(() => { native.list = old; fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }); });
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime(agentId), runnerRuntime: { async rpc(op, input) {
    calls.push({ op, input });
    if (op === 'job.dispatch') { turn++; accepted = { agentId, modelName: input.cfg.llm?.model || input.cfg.codex_model }; return { ok: true, data: { ref } }; }
    if (op === 'job.comment') { turn++; accepted = input.executionSelection || accepted; return { ok: true, data: { ok: true, acceptedSelection: accepted } }; }
    if (op === 'job.session') return { ok: true, data: { status: 'done', round: turn, activeExecutionSelection: accepted,
      items: [{ seq: turn, kind: 'say', text: 'Turn ' + turn }] } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error(op);
  } }, modelConfig: { fetchModel: async (_identity, name) => ({ ok: true, model: { id: 'provider-' + name, name,
    key: 'test', baseUrl: 'http://example.invalid/v1' } }) } });
  const s = await adapter.createSession({ runtimeId: 'test', identity: { clientId: 'test' }, native: { runner: { openOptions:
    { ref: alias, cwd: root, modelName: 'a', reasoningEffort: 'high' } } } });
  t.after(() => s.dispose()); const h = getRunnerSessionDetails(s).handle;
  const send = async text => { const result = await s.send({ text }).completion; assert.equal(result.ok, true, JSON.stringify(result)); };
  assert.equal((await h.selectModel('b')).ok, true); await send('First'); await send('Same model');
  assert.equal(calls.find(x => x.op === 'job.comment').input.executionSelection, undefined);
  assert.equal((await h.selectModel('c')).ok, true); await send('New model');
  const changed = calls.filter(x => x.op === 'job.comment').at(-1).input;
  assert.equal(changed.ref, ref);
  assert.equal(changed.executionSelection.modelName, agentId === 'codex' ? 'c' : 'provider-c');
  if (agentId === 'codex') {
    assert.equal(changed.executionSelection.reasoningEffort, 'high'); assert.equal(changed.cfg.codex_reasoning_effort, 'high');
  } else assert.equal(changed.cfg.llm.model, changed.executionSelection.modelName);
  await send('Same new model'); assert.equal(calls.filter(x => x.op === 'job.comment').at(-1).input.executionSelection, undefined);
});

test('Armonel forwards the conversation thinking choice on each supported Runner launch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-armonel-thinking-'));
  const alias = 'armonel-thinking-contract';
  const ref = _uuidV5('9af442c8-cd1d-4b91-a668-22da2b2635bf', 'chat:' + alias + ':armonel');
  const launches = [];
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('armonel'),
    runnerRuntime: { async rpc(op, input) {
      if (op === 'job.dispatch' || op === 'job.comment') {
        launches.push(input.cfg.llm);
        return { ok: true, data: { ok: true, ref } };
      }
      if (op === 'job.session') return { ok: true, data: { status: 'done', round: launches.length,
        items: [{ seq: launches.length, kind: 'say', text: 'Synthetic reply' }] } };
      if (op === 'job.stop') return { ok: true, data: { ok: true } };
      throw Error(op);
    } },
    modelConfig: { fetchModel: async (_identity, id) => ({ ok: true, model: {
      id, key: 'synthetic', baseUrl: 'http://fixture.invalid/v1',
      ...(id === 'reasoning' ? { reasoning: true, thinkingMode: 'controllable', thinkingFormat: 'openai',
        supportsReasoningEffort: true, thinkingLevelMap: { low: 'low', off: 'none' } } : {}),
    } }) },
  });
  const session = await adapter.createSession({ native: { runner: { openOptions: {
    ref: alias, cwd: root, modelName: 'reasoning', thinkingLevel: 'low',
  } } } });
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const handle = getRunnerSessionDetails(session).handle;
  assert.equal((await handle.submit('First turn', []).completion).ok, true);
  assert.equal((await handle.submit('Follow-up', []).completion).ok, true);
  assert.equal((await handle.selectModel('plain')).ok, true);
  assert.equal((await handle.submit('Different model', []).completion).ok, true);
  assert.deepEqual(launches.map(({ model, thinkingLevel }) => ({ model, thinkingLevel })), [
    { model: 'reasoning', thinkingLevel: 'low' },
    { model: 'reasoning', thinkingLevel: 'low' },
    { model: 'plain', thinkingLevel: undefined },
  ]);
});

test('a stopped DSH chat changes reasoning on the next prompt without replacing the session', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-dsh-thinking-'));
  const calls = [];
  let session;
  t.after(async () => { await session?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('dsh'),
    runnerRuntime: { async rpc(op, input) {
      if (op === 'job.comment') { calls.push(input); return { ok: true, data: { ok: true } }; }
      if (op === 'job.session') return { ok: true, data: calls.length ? { ok: true, status: 'done',
        round: calls.length + 1, items: [{ seq: calls.length, kind: 'say', text: 'Synthetic result' }] }
        : { ok: true, status: 'failed', error: 'Synthetic token exhaustion', failureKind: 'execution_incomplete', items: [] } };
      if (op === 'job.stop' || op === 'runtime.detect') return { ok: true, data: {} };
      throw Error(op);
    } },
    modelConfig: { fetchModel: async () => ({ ok: true, model: { id: 'fixture', key: 'synthetic',
      baseUrl: 'http://fixture.invalid/v1', reasoning: true, thinkingMode: 'controllable',
      thinkingFormat: 'openai', supportsReasoningEffort: true, thinkingLevelMap: { low: 'low', high: 'high', off: 'none' } } }) },
  });
  const request = { native: { runner: { openOptions: {
    app: { getPath: () => root }, ref: 'dsh-chat', resumePath: 'saved-dsh-session',
    cwd: root, modelName: 'fixture', thinkingLevel: 'high',
  } } } };
  session = await adapter.resumeSession(request);
  for (let attempt = 0; !session.snapshot().execution.terminalConfirmed && attempt < 100; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(session.snapshot().execution.terminalConfirmed, true);
  const handle = getRunnerSessionDetails(session).handle;
  assert.equal(handle.setThinkingLevel('medium').ok, false);
  assert.equal(handle.setThinkingLevel('off').thinking.level, 'off');
  assert.equal((await handle.submit('Continue', []).completion).ok, true);
  assert.equal(calls[0].ref, 'saved-dsh-session');
  assert.equal(calls[0].cfg.llm.thinkingLevel, 'off');
  assert.equal(handle.setThinkingLevel('').thinking.level, '');
  assert.equal((await handle.submit('Continue with provider defaults', []).completion).ok, true);
  assert.equal(calls[1].ref, 'saved-dsh-session');
  assert.equal(calls[1].cfg.llm.thinkingLevel, undefined);
  await session.dispose();
  session = await adapter.resumeSession(request);
  assert.equal(session.snapshot().thinking.level, '', 'the saved reset survives reopening');
});

test('resumed Runner history without saved model selection bypasses a stale Agent preference', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-recovery-'));
  const fetches = [];
  const runtime = { async rpc(op, input) {
    if (op === 'job.session') return { ok: true, data: { status: 'done', round: 0, items: [] } };
    if (op === 'runtime.detect') return { ok: true, data: { accessControl: {
      schema: 'soduwork.access-policy/v1', supported: true, modes: ['standard', 'readonly', 'full'] } } };
    if (op === 'job.stop') return { ok: true, data: { ok: true } };
    throw Error(op);
  } };
  const adapter = createRunnerRuntimeAdapter({ runtimeSpec: catalog.runtime('qwen'), runnerRuntime: runtime,
    modelConfig: { fetchModel: async (_identity, name, _timeout, _fetch, _force, agentId, options) => {
      fetches.push({ name, agentId, options: options || {} });
      if (!name && options?.ignoreAgentPreference === true) {
        return { ok: true, model: { id: 'current-model', name: 'Current model', key: 'test', baseUrl: 'http://example.invalid/v1' } };
      }
      return { ok: false, reason: '你选择的模型「dev-coding-large-agent-soduwork」现在不可用，请重新选择' };
    } },
  });
  const session = await adapter.resumeSession({ runtimeId: 'test', identity: { clientId: 'test', hub: 'http://fixture.invalid' },
    native: { runner: { openOptions: { ref: 'legacy', resumePath: 'runner-old', resumedConversation: true, cwd: root, modelName: '' } } } });
  t.after(async () => { await session.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 }); });
  assert.equal(session.snapshot().modelSelection.model.id, 'current-model');
  assert.deepEqual(fetches.map(row => row.name), ['', '']);
  assert.equal(fetches.at(-1).options.ignoreAgentPreference, true);
  await session.dispose();
  await assert.rejects(
    () => adapter.createSession({ runtimeId: 'test', identity: { clientId: 'test', hub: 'http://fixture.invalid' },
      native: { runner: { openOptions: { ref: 'new-chat', cwd: root, modelName: 'stale-model' } } } }),
    /dev-coding-large-agent-soduwork/,
    'a new chat must keep an explicit unavailable model error instead of silently falling back',
  );
});
