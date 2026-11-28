'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../main/agent-runtime/runner-config.cjs');

test('Runner carries declared thinking mappings to the same selected model', () => {
  const model = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias',
    reasoning: true, thinkingMode: 'always', thinkingAlwaysOn: true, thinkingFormat: 'zai', supportsReasoningEffort: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', high: 'high' } };
  for (const adapter of ['qwen', 'kimi', 'opencode']) {
    const cfg = create(model, adapter, ['read']);
    assert.equal(cfg.local_cli, adapter);
    assert.equal(cfg.llm.model, model.id);
    assert.equal(cfg.llm.thinkingMode, 'always');
    assert.equal(cfg.llm.thinkingAlwaysOn, true);
    assert.equal(Object.hasOwn(cfg.llm, 'thinkingLevel'), false);
    assert.equal(cfg.llm.thinkingFormat, 'zai');
    assert.equal(cfg.llm.supportsReasoningEffort, true);
    assert.deepEqual(cfg.llm.thinkingLevelMap, model.thinkingLevelMap);
    cfg.llm.thinkingLevelMap.low = 'changed';
    assert.equal(model.thinkingLevelMap.low, 'low');
  }
});

test('Normalized profiles survive and unknown models receive no invented mapping', () => {
  const base = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias' };
  const normalized = create({ ...base, reasoning: true, format: 'openai',
    supportsReasoningEffort: true, thinkingLevelMap: { low: 'medium' } }, 'qwen').llm;
  assert.equal(normalized.thinkingFormat, 'openai');
  assert.deepEqual(normalized.thinkingLevelMap, { low: 'medium' });
  const plain = create(base, 'qwen').llm;
  assert.equal(plain.thinkingLevelMap, undefined);
  assert.equal(plain.thinkingFormat, undefined);
  for (const field of ['reasoning', 'thinkingMode', 'thinkingAlwaysOn', 'thinkingLevel']) {
    assert.equal(Object.hasOwn(plain, field), false, field);
  }
  const native = create(base, 'codex');
  assert.equal(native.codex_model, base.id);
});

test('Runner preserves declared controllable and disabled reasoning without selecting a level', () => {
  const base = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias' };
  for (const adapter of ['qwen', 'kimi', 'opencode']) {
    const controllable = create({ ...base, thinkingMode: 'controllable', thinkingAlwaysOn: false,
      thinkingFormat: 'qwen', supportsReasoningEffort: false }, adapter).llm;
    assert.equal(controllable.reasoning, true);
    assert.equal(controllable.thinkingMode, 'controllable');
    assert.equal(controllable.thinkingAlwaysOn, false);
    assert.equal(controllable.thinkingFormat, 'qwen');
    assert.equal(Object.hasOwn(controllable, 'thinkingLevel'), false);
    assert.equal(Object.hasOwn(controllable, 'thinkingLevelMap'), false);
    const disabled = create({ ...base, reasoning: true, thinkingMode: 'none', thinkingAlwaysOn: false }, adapter).llm;
    assert.equal(disabled.thinkingMode, 'none');
    assert.equal(disabled.thinkingAlwaysOn, false);
    assert.equal(Object.hasOwn(disabled, 'reasoning'), false);
    assert.equal(Object.hasOwn(disabled, 'thinkingFormat'), false);
    assert.equal(Object.hasOwn(disabled, 'thinkingLevel'), false);
  }
});

test('Runner forwards only explicit supported thinking levels and typed policy declarations', () => {
  const base = { baseUrl: 'https://fixture.invalid', key: 'fixture', id: 'managed-alias',
    thinkingMode: 'controllable', reasoning: true };
  for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.equal(create({ ...base, thinkingLevel: level }, 'qwen').llm.thinkingLevel, level);
  }
  for (const invalid of [undefined, null, '', 'AUTO', 'controllable ', true, 1, {}]) {
    const llm = create({ ...base, thinkingMode: invalid, thinkingAlwaysOn: invalid,
      thinkingLevel: invalid }, 'qwen').llm;
    assert.equal(Object.hasOwn(llm, 'thinkingMode'), false);
    assert.equal(Object.hasOwn(llm, 'thinkingLevel'), false);
    assert.equal(Object.hasOwn(llm, 'thinkingAlwaysOn'), typeof invalid === 'boolean');
    if (typeof invalid === 'boolean') assert.equal(llm.thinkingAlwaysOn, invalid);
  }
});

test('Armonel forwards explicit off only when the active model declares the wire off value', () => {
  const model = { id: 'fixture', key: 'synthetic', baseUrl: 'http://fixture.invalid/v1',
    reasoning: true, thinkingMode: 'controllable', thinkingFormat: 'openai', supportsReasoningEffort: true,
    thinkingLevelMap: { off: 'none', low: 'low' } };
  assert.equal(create(model, 'armonel', [], 'off').llm.thinkingLevel, 'off');
  assert.equal(create(model, 'qwen', [], 'off').llm.thinkingLevel, undefined);
  assert.equal(create(model, 'armonel', []).llm.thinkingLevel, undefined);
  for (const override of [ { thinkingMode: 'always' }, { thinkingAlwaysOn: true },
    { thinkingFormat: 'qwen' }, { supportsReasoningEffort: false }, { thinkingLevelMap: { off: null } } ]) {
    assert.equal(create({ ...model, ...override }, 'armonel', [], 'off').llm.thinkingLevel, undefined);
  }
});

test('DSH forwards only explicitly selected and declared reasoning levels', () => {
  const model = { id: 'fixture', key: 'synthetic', baseUrl: 'http://fixture.invalid/v1',
    reasoning: true, thinkingMode: 'controllable', thinkingFormat: 'openai', supportsReasoningEffort: true,
    thinkingLevelMap: { off: 'none', low: 'low', high: 'high' } };
  assert.equal(create(model, 'dsh', [], 'off').llm.thinkingLevel, 'off');
  assert.equal(create(model, 'dsh', [], 'low').llm.thinkingLevel, 'low');
  assert.equal(create({ ...model, thinkingLevel: 'high' }, 'dsh', []).llm.thinkingLevel, 'high');
  assert.equal(create(model, 'dsh', []).llm.thinkingLevel, undefined);
  assert.equal(create(model, 'dsh', [], 'medium').llm.thinkingLevel, undefined);
  assert.equal(create({ ...model, thinkingMode: 'always' }, 'dsh', [], 'low').llm.thinkingLevel, 'low');
  for (const override of [{ thinkingMode: 'always' }, { thinkingAlwaysOn: true },
    { thinkingFormat: 'qwen' }, { supportsReasoningEffort: false }, { thinkingLevelMap: { off: 'none' } },
    { thinkingLevelMap: { off: null, low: 'low' } }, { id: 'glm_5.3_flash' }]) {
    assert.equal(create({ ...model, ...override }, 'dsh', [], 'off').llm.thinkingLevel, undefined);
  }
});

test('Runner keeps keyless local model configuration on the local execution boundary', () => {
  const cfg = create({ localOnly: true, authMode: 'none', baseUrl: 'http://127.0.0.1:11434/v1',
    key: '', id: 'local:opaque-reference', wireModelId: 'qwen-local-wire' }, 'qwen');
  assert.equal(cfg.llm.base, 'http://127.0.0.1:11434/v1');
  assert.equal(cfg.llm.key, '');
  assert.equal(cfg.llm.model, 'qwen-local-wire');
  assert.equal(cfg.llm.localOnly, true);
  assert.equal(cfg.llm.authMode, 'none');
});
