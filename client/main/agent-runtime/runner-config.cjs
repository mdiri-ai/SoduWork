'use strict';

const contextWindow = require('../conversation/context-window');
const modelSelection = require('../conversation/model-selection');
const thinkingCapabilities = require('../conversation/thinking-capabilities');
const capabilityContract = require('../model-capability-contract.cjs');

function supportsArmonelThinking(llm, level) {
  if (!thinkingCapabilities.LEVELS.includes(level) || llm.reasoning !== true ||
      llm.thinkingFormat !== 'openai' || llm.supportsReasoningEffort !== true) return false;
  const effort = llm.thinkingLevelMap?.[level];
  if (level === 'off') return llm.thinkingMode === 'controllable' &&
    llm.thinkingAlwaysOn !== true && effort === 'none';
  return effort !== 'off' && thinkingCapabilities.LEVELS.includes(effort);
}

function dshThinking(model, level) {
  if (!model || model.reasoning === false ||
      !['always', 'controllable'].includes(model.thinkingMode) || model.supportsReasoningEffort !== true ||
      !['openai', 'zai', 'deepseek'].includes(model.thinkingFormat || model.format)) {
    return { supported: false, canDisable: false, level: '', levels: [] };
  }
  const mapping = model.thinkingLevelMap || {};
  const levels = thinkingCapabilities.LEVELS.slice(1).filter(key => typeof mapping[key] === 'string' &&
    !['', 'none', 'off'].includes(mapping[key].trim()));
  const canDisable = levels.length > 0 && model.thinkingMode === 'controllable' &&
    model.thinkingAlwaysOn !== true && mapping.off === 'none' && !thinkingCapabilities.conflict(model);
  if (canDisable) levels.unshift('off');
  const active = levels.includes(level) ? level : '';
  return { supported: levels.length > 0, canDisable, level: active, enabled: Boolean(active && active !== 'off'), levels };
}

// Ordinary turns and workflow nodes use the same managed-model contract,
// including when a running node receives a renewed model ticket.
function create(model, adapterId, capabilityIds, thinkingLevel) {
  const cfg = { local_cli: String(adapterId || 'codex-harness') };
  if (adapterId === 'codex') cfg.codex_model = String(model && model.id || '');
  const requiredCapabilities = Array.from(new Set((Array.isArray(capabilityIds)
    ? capabilityIds : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean)));
  if (requiredCapabilities.length) cfg.requiredCapabilities = requiredCapabilities;
  capabilityContract.assertRequired(model, [
    ...(adapterId === 'pi' ? ['streaming'] : []),
    ...(requiredCapabilities.length ? ['toolCalling'] : []),
  ]);
  // Local providers may intentionally have no API key (for example an
  // Ollama-compatible endpoint). Keep the opaque local reference out of the
  // child process and use the provider's wire model id instead.
  const wireModel = model && model.localOnly
    ? String(model.wireModelId || model.modelName || model.id || '')
    : String(model && model.id || '');
  const hasModelConfig = model && model.baseUrl && wireModel &&
    (model.localOnly || model.key);
  if (hasModelConfig) {
    const thinking = thinkingCapabilities.profile(model);
    cfg.llm = {
      base: String(model.baseUrl), key: String(model.key || ''), model: wireModel,
      ...(model.localOnly ? { localOnly: true, authMode: model.authMode || 'api-key' } : {}),
      ...(model.quotaVersion === 2 && model.quotaUsageToken && !model.localOnly ? {
        quotaVersion: 2, quotaUsageToken: model.quotaUsageToken,
        quotaProvider: model.quotaProvider || '',
      } : {}),
      maxOutputTokens: modelSelection.outputLimit(model),
      ...(['none', 'always', 'controllable'].includes(model.thinkingMode)
        ? { thinkingMode: model.thinkingMode } : {}),
      ...(typeof model.thinkingAlwaysOn === 'boolean' ? { thinkingAlwaysOn: model.thinkingAlwaysOn } : {}),
      ...(adapterId !== 'dsh' && thinkingCapabilities.LEVELS.includes(model.thinkingLevel)
        ? { thinkingLevel: model.thinkingLevel } : {}),
      ...(thinking.reasoning && (model.reasoning === true || ['always', 'controllable'].includes(model.thinkingMode)) ? {
        reasoning: true,
        thinkingFormat: thinking.format,
        supportsReasoningEffort: thinking.supportsReasoningEffort,
        ...(thinking.thinkingLevelMap ? { thinkingLevelMap: { ...thinking.thinkingLevelMap } } : {}),
      } : {}),
      ...(model.capabilityProfile ? { capabilityProfile: model.capabilityProfile } : {}),
      ...(model.compatibility ? { compatibility: capabilityContract.compatibility(model.compatibility) } : {}),
      ...(model.configRevision ? { configRevision: model.configRevision } : {}),
      ...(model.runtimeRevision ? { runtimeRevision: model.runtimeRevision } : {}),
      ...(Array.isArray(model.input) ? { input: model.input.filter(value => value === 'text' || value === 'image') } : {}),
      ...(['native', 'vision-fallback'].includes(model.imageRouting) ? { imageRouting: model.imageRouting } : {}),
      ...(typeof model.visionFallbackAvailable === 'boolean' ? { visionFallbackAvailable: model.visionFallbackAvailable } : {}),
      ...contextWindow.resolveContextWindow(model),
    };
    if (adapterId === 'armonel') {
      const declared = model.declaredThinking ?? thinkingCapabilities.declaration(model);
      const levels = cfg.llm.thinkingLevelMap;
      Object.assign(cfg.llm, declared);
      if (levels || declared.thinkingLevelMap) {
        cfg.llm.thinkingLevelMap = { ...declared.thinkingLevelMap, ...levels };
      }
      if (supportsArmonelThinking(cfg.llm, thinkingLevel)) cfg.llm.thinkingLevel = thinkingLevel;
    }
    if (adapterId === 'dsh') {
      const selection = dshThinking(model, thinkingLevel ?? model.thinkingLevel);
      if (selection.level) cfg.llm.thinkingLevel = selection.level;
    }
  }
  return cfg;
}

module.exports = { create, dshThinking };
