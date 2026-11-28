// Host-only compatibility for @openma/deepseek-harness-acp 0.4.40/0.4.41.
// These adapters settle a prompt at parent idle, before progressing descendants
// have delivered their results. Follow DSH's native waitForChildren contract
// inside that prompt, without changing Agent.whenIdle for other callers.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REASONING_ENV = 'SODUWORK_DSH_MANAGED_REASONING';
export let managedReasoning = null;

export function applyManagedReasoning(record, route, selection, override) {
  if (route?.provider !== override.provider || route?.model !== override.model || !selection) {
    throw new Error('DeepSeek Harness did not restore the selected managed reasoning model.');
  }
  // `session/set_config_option` also writes native product-wide defaults.
  // Use the same selection object only for this managed ACP process instead.
  selection.current = { provider: route.provider, model: route.model,
    ...(override.level ? { reasoningEffort: override.level } : {}) };
  record.effort = override.level || undefined;
}

export async function waitForSettlement(agent, subagents, signal) {
  if (typeof agent?.whenIdle !== 'function'
      || typeof subagents?.waitForChildren !== 'function') {
    throw new Error('DeepSeek Harness child settlement interface is unavailable; repair the runtime or update SoduWork.');
  }
  signal.throwIfAborted();
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    while (true) {
      await Promise.race([agent.whenIdle(), cancelled]);
      signal.throwIfAborted();
      const seq = agent.session?.seq;
      if (!Number.isSafeInteger(seq) || seq < 0) {
        throw new Error('DeepSeek Harness session sequence is unavailable; update SoduWork.');
      }
      const joined = await Promise.race([subagents.waitForChildren(agent), cancelled]);
      signal.throwIfAborted();
      // Joining a child can wake the parent and admit another turn. Idle resident
      // children are deliberately excluded by DSH's own waitForChildren service.
      if (joined || agent.status !== 'idle' || agent.session.seq !== seq) continue;
      return;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

const START = '        const stopReason = await new Promise(';
const END = '        const usage = record.projection.promptUsage();';
// Hash the complete upstream prompt settlement block, not a loose substring.
// A changed adapter must be reviewed before this compatibility fix is applied.
const SETTLEMENT_HASHES = new Map([
  ['0.4.40', '2b28c53b694972ade01775573aac8e51399db7f5407115bbbc71373ddc89e2ee'],
  ['0.4.41', 'ac3db9a394876ec5b33b4c859a4863786b1d11838672fc4cea0b1bac48367d16'],
]);
const MANAGED_SELECTION_HASHES = [
  ['  const routeOf = (record) => {', 'da3014c81dbf49f963bb762aae7db91cd61cd10702d0b3d6f064ad9e839d4b10'],
  ['  const ensureSelection = (record) => {', 'b56377f267147dac5d6a5f1754d0bfdcd712de9e723fb6706006c5f64d221ae7'],
];
const TURN_END_START = '  onTurnEnd(data) {';
const TURN_END_END = '\n  }';
const TURN_END_HASH = '1950482fe50555b215721716d9b69e261c82431e9a1bce9a7de04eaecd15ef25';
const CANCEL_HANDLER = `      cancel(params) {
        const record = sessions.get(params.sessionId);
        if (record === void 0) return Promise.resolve();
        record.cancelled = true;
        record.agent.cancel({ kind: "user" });
        settlePrompt(record, "cancelled");
        return Promise.resolve();
      }`;
const DISCARD_PREVIEWS = `    const updates = [];
    // DSH drops tool calls in a max-tokens response before admitting them for
    // execution. Settle only native pending previews, never an executing tool.
    if (reason?.kind === 'max-tokens') {
      for (const state of this.toolCalls.values()) {
        if (state.status !== 'pending') continue;
        updates.push({
          sessionUpdate: 'tool_call_update',
          toolCallId: state.callId,
          status: 'failed',
          _meta: { soduwork: { toolOutcome: 'not-executed', reason: 'output-limit' } }
        });
      }
    }
`;

const REPLACEMENT = `        const stopReason = await new Promise((resolve, reject) => {
          const controller = new AbortController();
          const inflight = {
            resolve(value) { controller.abort(); resolve(value); },
            reject(error) { controller.abort(); reject(error); },
            messageId: message.id,
            turn: void 0
          };
          record.inflight = inflight;
          try {
            if (__soduworkManagedReasoning) {
              __soduworkApplyManagedReasoning(record, routeOf(record), ensureSelection(record), __soduworkManagedReasoning);
            }
            deliverPrompt(record.agent, message, false);
          } catch (error) {
            record.inflight = void 0;
            inflight.reject(internalError('prompt was not queued: ' + errorChain2(error)));
            return;
          }
          void __soduworkWaitForSettlement(record.agent, subagents, controller.signal).then(() => {
            if (record.inflight !== inflight) return;
            record.inflight = void 0;
            if (record.cancelled) {
              inflight.resolve('cancelled');
              return;
            }
            // A child result can start a new parent turn. Its final outcome,
            // including output limits and errors, supersedes the first turn.
            const end = record.projection.lastTurnEnd;
            const failure = record.projection.turnError ?? (end?.kind === 'error' ? end.error : void 0);
            if (failure !== void 0) {
              const detail = 'turn failed: ' + errorChain2(failure);
              inflight.reject(looksLikeAuthFailure(detail) ? authError(detail) : internalError(detail));
              return;
            }
            inflight.resolve(end === void 0 ? 'cancelled' : turnEndToStopReason(end));
          }).catch(error => {
            // Cancellation/close may already have settled this prompt and
            // admitted a new one. A late rejection cannot change its owner.
            if (record.inflight !== inflight) return;
            record.inflight = void 0;
            inflight.reject(internalError('prompt settlement failed: ' + errorChain2(error)));
          });
        });
`;

export function transformBridgeSource(source, version) {
  const expected = SETTLEMENT_HASHES.get(version);
  const start = source.indexOf(START);
  const end = source.indexOf(END, start);
  if (!expected || start < 0 || end < start || source.indexOf(START, start + START.length) !== -1
      || source.indexOf(END, end + END.length) !== -1
      || createHash('sha256').update(source.slice(start, end)).digest('hex') !== expected) {
    throw new Error('DeepSeek Harness ACP prompt interface is unsupported (' + version
      + '); update SoduWork before running this adapter.');
  }
  if (managedReasoning && MANAGED_SELECTION_HASHES.some(([anchor, hash]) => {
    const first = source.indexOf(anchor);
    const next = source.indexOf('\n  const ', first + anchor.length);
    return first < 0 || next < first || source.indexOf(anchor, first + anchor.length) !== -1 ||
      createHash('sha256').update(source.slice(first, next)).digest('hex') !== hash;
  })) {
    throw new Error('DeepSeek Harness managed reasoning interface is unsupported (' + version +
      '); update SoduWork before running this adapter.');
  }
  const turnStart = source.indexOf(TURN_END_START);
  const turnEnd = source.indexOf(TURN_END_END, turnStart) + TURN_END_END.length;
  const turnBlock = source.slice(turnStart, turnEnd);
  if (turnStart < 0 || turnEnd <= turnStart
      || source.indexOf(TURN_END_START, turnStart + TURN_END_START.length) !== -1
      || createHash('sha256').update(turnBlock).digest('hex') !== TURN_END_HASH) {
    throw new Error('DeepSeek Harness ACP tool preview interface is unsupported (' + version
      + '); update SoduWork before running this adapter.');
  }
  const cancelStart = source.indexOf(CANCEL_HANDLER);
  if (cancelStart < 0 || source.indexOf(CANCEL_HANDLER, cancelStart + CANCEL_HANDLER.length) !== -1) {
    throw new Error('DeepSeek Harness ACP cancellation interface is unsupported (' + version
      + '); update SoduWork before running this adapter.');
  }
  // Both complete native blocks have been reviewed. Replace by their verified
  // content so bundle layout changes cannot invalidate stored offsets.
  const fixedTurn = turnBlock.replace('    this.toolCallBlocks.clear();',
    DISCARD_PREVIEWS + '    this.toolCallBlocks.clear();').replace('    return [];', '    return updates;');
  // The cancellation notification dispatches abort. The existing prompt
  // settlement waiter owns the reply after the parent and children are idle.
  const fixedCancel = CANCEL_HANDLER.replace('        settlePrompt(record, "cancelled");\n', '');
  return 'import { waitForSettlement as __soduworkWaitForSettlement, managedReasoning as __soduworkManagedReasoning, '
    + 'applyManagedReasoning as __soduworkApplyManagedReasoning } from '
    + JSON.stringify(import.meta.url) + ';\n'
    + source.replace(source.slice(start, end), REPLACEMENT).replace(turnBlock, fixedTurn)
      .replace(CANCEL_HANDLER, fixedCancel);
}

if (process.env.SODUWORK_DSH_ACP_SETTLEMENT === '1') {
  delete process.env.SODUWORK_DSH_ACP_SETTLEMENT;
  if (process.env[REASONING_ENV]) {
    const value = JSON.parse(process.env[REASONING_ENV]);
    delete process.env[REASONING_ENV];
    if (value?.provider !== 'soduwork' || typeof value.model !== 'string' || !value.model ||
        !['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.level)) {
      throw new Error('DeepSeek Harness received an invalid managed reasoning setting.');
    }
    managedReasoning = value;
  }
  // Do not pass the host preload into tools or unrelated child Node processes.
  delete process.env.NODE_OPTIONS;
  registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith('file:')) return nextLoad(url, context);
      const file = fileURLToPath(url);
      const directory = dirname(file);
      const root = dirname(directory);
      if (!['bridge.js', 'plugin.js', 'server.js'].includes(basename(file))
          || basename(directory) !== 'dist' || basename(root) !== 'deepseek-harness-acp'
          || basename(dirname(root)) !== '@openma') return nextLoad(url, context);
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      if (manifest.name !== '@openma/deepseek-harness-acp') {
        throw new Error('DeepSeek Harness ACP package identity is invalid; repair the adapter.');
      }
      const loaded = nextLoad(url, context);
      if (loaded.format !== 'module' || loaded.source == null) {
        throw new Error('DeepSeek Harness ACP module format is unsupported; update SoduWork.');
      }
      const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
      return { ...loaded, source: transformBridgeSource(source, manifest.version) };
    },
  });
}
