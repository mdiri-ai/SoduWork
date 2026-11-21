'use strict';
const goalQuality = require('../conversation/goal-quality');
const modelErrors = require('./model-errors');
const preparation = require('./tool-preparation');
const toolDetail = require('./tool-detail');
const { selectTools } = require('./snapshot-window');
const agentSource = require('../conversation/agent-source.cjs');
const turnMetrics = require('./turn-metrics');
const usageValues = require('../agent-runtime/usage-values');
/* Project blocks in contentIndex order and place tools after their owning messages. */
function _snapshotCache(state) {
  if (!state._snapshotCache) {
    /* Completed messages and tools are immutable after their terminal event.
       Keep their already-cleaned public projection so a streaming token only
       rebuilds the active block instead of reprocessing the whole transcript. */
    Object.defineProperty(state, '_snapshotCache', {
      configurable: true, writable: true, enumerable: false,
      value: { auditKey: '', messages: new WeakMap(), tools: new WeakMap() },
    });
  }
  return state._snapshotCache;
}

function accountingReceipts(state, cache) {
  if (cache.receiptRevision === state.usageRevision && cache.receiptMessages === state.messages &&
      cache.receiptCount === state.messages.length && cache.receiptHistory === state.accountingHistory && cache.receipts) return cache.receipts;
  cache.receiptRevision = state.usageRevision;
  cache.receiptMessages = state.messages;
  cache.receiptCount = state.messages.length;
  cache.receiptHistory = state.accountingHistory;
  const history = Array.isArray(state.accountingHistory) ? state.accountingHistory : [];
  const live = state.messages.slice(state.accountingMessageFrom || 0);
  cache.receipts = history.concat(live.filter(m => m.role === 'assistant' && m.done && m.usage)
    .map(m => ({ usage: m.usage, at: m.usageAt || m.completedAt || 0,
      model: m.usageModel || '', provider: m.usageProvider || '', agent: m.sourceAgent?.agentId || '',
      ...(m.usageLocalOnly === true ? { localOnly: true } : {}),
      ...(m.quotaUsageToken ? { quotaUsageToken: m.quotaUsageToken } : {}) })));
  return cache.receipts;
}

/*
 * A finished task quotes one token number in two places: the turn footer and the Hub
 * ledger. Both must read the same receipts through the same rules, so receipts the
 * reporter would refuse to bill (device-only models, non-reportable calls) are dropped
 * here as well instead of quietly inflating the number a user is asked to trust.
 */
function billableReceipt(receipt) {
  if (!receipt) return false;
  if (receipt.localOnly === true || receipt.reportable === false) return false;
  return !(typeof receipt.model === 'string' && receipt.model.trim().startsWith('local:'));
}

function billableMessage(message) {
  return Boolean(message) && message.role === 'assistant' && message.done === true &&
    Boolean(message.usage) && message.usageLocalOnly !== true &&
    !String(message.usageModel || '').trim().startsWith('local:');
}

/* Every counter below goes through usage-values so a turn total and the session total
   cannot drift apart on cache or reasoning handling. */
function receiptTokens(receipts) {
  const total = usageValues.empty();
  for (const receipt of receipts) {
    if (billableReceipt(receipt)) usageValues.add(total, receipt.usage);
  }
  return total;
}

function usageSummary(state, cache) {
  const receipts = accountingReceipts(state, cache);
  if (cache.summaryFrom === receipts) return cache.summary;
  const total = receiptTokens(receipts);
  let agent = '', model = '', provider = '', latestAt = 0;
  for (const receipt of receipts) {
    if (!billableReceipt(receipt)) continue;
    if (Number(receipt.at) > latestAt) latestAt = Number(receipt.at);
    if (receipt.agent) agent = String(receipt.agent);
    if (receipt.model) model = String(receipt.model);
    if (receipt.provider) provider = String(receipt.provider);
  }
  cache.summaryFrom = receipts;
  cache.summary = Object.freeze({
    tokens: total.total, input: total.input, output: total.output,
    requests: total.requests, turns: total.turns, latestAt,
    agent, model, provider,
    costMicrousd: total.costMicrousd, costKnown: total.costKnown,
  });
  return cache.summary;
}

/*
 * A replayed conversation keeps every archived receipt in accountingHistory and starts the
 * live window after the last restored message, so message indices alone cannot cover older
 * turns. The archived receipts still carry their own timestamps, so keep a running total
 * ordered by time and let a turn read the value it had when it ended.
 */
function archivedTimeline(receipts) {
  const ordered = receipts.filter(billableReceipt)
    .map(receipt => ({ at: Number(receipt.at) || 0, usage: receipt.usage }))
    .sort((left, right) => left.at - right.at);
  const timeline = [];
  let running = 0;
  for (const row of ordered) {
    const one = usageValues.empty();
    usageValues.add(one, row.usage);
    running += one.total;
    timeline.push({ at: row.at, total: running });
  }
  return timeline;
}

function archivedTotalAt(timeline, at) {
  if (!timeline.length) return 0;
  if (!at) return timeline[timeline.length - 1].total;
  let low = 0, high = timeline.length - 1, found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (timeline[mid].at <= at) { found = timeline[mid].total; low = mid + 1; }
    else high = mid - 1;
  }
  return found;
}

function addTurnCumulatives(rows, cumulative, messages) {
  return rows.map(row => {
    const index = Number(row.toMessage || -1);
    const live = cumulative.byIndex.get(index);
    if (live != null) return { ...row, cumulativeTokens: live };
    const endedAt = Number(messages?.[index]?.completedAt) || 0;
    return { ...row, cumulativeTokens: archivedTotalAt(cumulative.timeline, endedAt) };
  });
}

function injectTurnCumulatives(bounded, rows, state, cache, visibleAfter) {
  const cumulative = turnCumulative(state, cache);
  const withTotals = addTurnCumulatives(rows, cumulative, state.messages);
  if (bounded) return withTotals;
  return withTotals.map(row => ({ ...row,
    fromMessage: visibleAfter[row.fromMessage], toMessage: visibleAfter[row.toMessage] }));
}

/*
 * A footer must report what the task had consumed when that turn ended, not the number it
 * will reach later, or every finished turn would quote today's total. This walks the same
 * receipts the ledger bills and records the running total at each raw message index, so a
 * turn can read its own value from its last assistant message.
 */
function turnCumulative(state, cache) {
  const history = Array.isArray(state.accountingHistory) ? state.accountingHistory : [];
  const from = Number(state.accountingMessageFrom) || 0;
  if (cache.cumulativeHistory === state.accountingHistory &&
      cache.cumulativeFrom === from && cache.cumulativeMessages === state.messages &&
      cache.cumulativeCount === state.messages.length &&
      cache.cumulativeRevision === state.usageRevision) return cache.cumulative;
  const timeline = archivedTimeline(history);
  const byIndex = new Map();
  let running = timeline.length ? timeline[timeline.length - 1].total : 0;
  for (let index = from; index < state.messages.length; index += 1) {
    const message = state.messages[index];
    if (billableMessage(message)) {
      const one = usageValues.empty();
      usageValues.add(one, message.usage);
      running += one.total;
    }
    byIndex.set(index, running);
  }
  cache.cumulativeHistory = state.accountingHistory;
  cache.cumulativeFrom = from;
  cache.cumulativeMessages = state.messages;
  cache.cumulativeCount = state.messages.length;
  cache.cumulativeRevision = state.usageRevision;
  cache.cumulative = { byIndex, timeline };
  return cache.cumulative;
}

function _snapshotAuditKey(state) {
  return [state.auditFrom, state.auditUntil, state.auditPreliminary,
    state.auditPlainFrom, state.auditRevealed ? 1 : 0,
    (state.auditHidden || []).join(',')].join('|');
}

/*
 * Bound large tool and pasted-text projections to avoid megabyte-scale IPC serialization
 * during streaming. Keep the accumulator and model context intact, and preserve full
 * assistant content.
 */
const SNAP_TEXT_LIMIT = 12 * 1024;
const SNAP_TEXT_MARK = '\n…（内容过大，已截断显示）';
function snapText(value, limit, keepTail) {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return keepTail
    ? '…' + value.slice(-(limit - 24)) + SNAP_TEXT_MARK
    : value.slice(0, limit) + SNAP_TEXT_MARK;
}

/* Render a UI-safe projection. The accumulator remains the source of truth;
   this function only controls how much work each live snapshot performs. */
function snapshot(state, options, { SCOPES, deriveStatus, statusText }) {
  const VALID_SCOPES = new Set(Object.values(SCOPES));
  const opts = options && typeof options === 'object' ? options : {};
  const requestedMessageLimit = Number(opts.messageLimit);
  const bounded = Number.isFinite(requestedMessageLimit) && requestedMessageLimit > 0;
  const messageLimit = bounded
    ? Math.min(Math.max(Math.floor(requestedMessageLimit), 1), 2000) : Infinity;
  const requestedToolLimit = Number(opts.toolLimit);
  const toolLimit = bounded
    ? Math.min(Math.max(Math.floor(requestedToolLimit || messageLimit * 2), 1), 4000) : Infinity;
  const cache = _snapshotCache(state);
  const auditKey = _snapshotAuditKey(state);
  if (cache.auditKey !== auditKey) {
    cache.auditKey = auditKey;
    cache.messages = new WeakMap();
    cache.tools = new WeakMap();
  }
  let startRawIndex = 0;
  if (bounded && state.messages.length > messageLimit) {
    let remaining = 0;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index];
      if (message && (message.role === 'user' || message.role === 'assistant')) {
        remaining += 1;
        if (remaining >= messageLimit) {
          startRawIndex = index;
          break;
        }
      }
    }
  }
  const messages = [];
  const messageIndices = [];
  const metrics = turnMetrics.collector(state, cache, startRawIndex);
  const visibleAfter = bounded ? new Map() : [];
  const markVisibleAfter = (index, value) => {
    if (bounded) visibleAfter.set(index, value);
    else visibleAfter[index] = value;
  };
  for (let messageIndex = startRawIndex; messageIndex < state.messages.length; messageIndex += 1) {
    const m = state.messages[messageIndex];
    metrics.visit(m, messageIndex);
    if (messageIndex === state.auditPreliminary || state.auditHidden.includes(messageIndex)) {
      markVisibleAfter(messageIndex, messages.length - 1); continue;
    }
    const scope = VALID_SCOPES.has(m.scope) ? m.scope : '';
    const scopedInternal = m.role === 'assistant' &&
      [SCOPES.GOAL_PROGRESS, SCOPES.GOAL_EXECUTION, SCOPES.GOAL_REVIEW].includes(scope);
    const legacyInternal = !scope && m.role === 'assistant' && state.auditFrom >= 0 &&
      messageIndex >= state.auditFrom && (state.auditUntil < 0 || messageIndex < state.auditUntil);
    const internalAudit = scopedInternal || legacyInternal;
    let visible = m.done === true ? cache.messages.get(m) : null;
    if (!visible) {
      const capText = m.role === 'user' ? (text) => snapText(text, SNAP_TEXT_LIMIT, false) : (text) => text;
    const blocks = m.blocks.slice().sort((a, b) => a.index - b.index)
        .map((b) => ({ index: b.index, kind: b.kind,
          text: b.kind === 'toolcall' ? '' : b.kind === 'text'
            ? capText(scope === SCOPES.GOAL_FINAL
              ? goalQuality.cleanVisible(b.text)
              : (internalAudit
                ? (state.auditRevealed && scope === SCOPES.GOAL_REVIEW
                  ? goalQuality.auditVisible(b.text)
                  : (state.auditRevealed && legacyInternal
                    ? (messageIndex >= state.auditPlainFrom && state.auditPlainFrom >= 0
                      ? goalQuality.cleanVisible(b.text) : goalQuality.auditVisible(b.text)) : ''))
                : goalQuality.cleanVisible(b.text)))
            : (internalAudit ? '' : b.text),
          done: b.done, toolCall: b.kind === 'toolcall'
            ? (preparation.shortCall(b.toolCall) || (b.toolCall ? { id: b.toolCall.id, name: b.toolCall.name } : null)) : b.toolCall }))
        .filter((b) => !internalAudit || (b.kind === 'text' && Boolean(b.text)));
      visible = {
        role: m.role, done: m.done, usage: m.usage, stopReason: m.stopReason || '',
        ...agentSource.fields(m.sourceAgent),
        sentAt: m.sentAt || 0, completedAt: m.completedAt || 0,
        ...(m.taskId ? { taskId: String(m.taskId) } : {}),
        ...(m.taskOutputKey ? { taskOutputKey: String(m.taskOutputKey) } : {}),
        ...(m.role === 'user' && m.submissionId ? { submissionId: String(m.submissionId).slice(0, 128) } : {}),
        errorMessage: modelErrors.forDisplay(m.errorMessage || '', 200, m.afterToolResult), text: m.text || '', attachments: m.attachments || [], plugins: m.plugins || [], blocks,
        scope: scope || SCOPES.NORMAL,
      };
      if (m.done === true) cache.messages.set(m, visible);
    }
    const previous = messages[messages.length - 1];
    const mergeContinuation = Boolean(m.continuation) && previous &&
      previous.role === 'assistant' && previous.scope === visible.scope &&
      agentSource.same(previous.sourceAgent, visible.sourceAgent);
    if (mergeContinuation) {
      /* Never mutate a cached projection: it may be reused by the next
         snapshot and must still represent only its source message. */
      const merged = { ...previous, blocks: previous.blocks.slice() };
      const offset = merged.blocks.length;
      merged.blocks.push(...visible.blocks.map((block, index) => ({
        ...block, index: offset + index,
      })));
      merged.done = visible.done;
      merged.completedAt = visible.done ? visible.completedAt || 0 : 0;
      merged.usage = visible.usage || merged.usage;
      merged.stopReason = visible.stopReason || merged.stopReason;
      merged.errorMessage = visible.errorMessage || merged.errorMessage;
      messages[messages.length - 1] = merged;
    } else if (visible.role !== 'assistant' || visible.blocks.length) {
      messages.push(visible);
      if (bounded) messageIndices.push(messageIndex);
    }
    markVisibleAfter(messageIndex, messages.length - 1);
  }
  // Retain running tools even when historical messages are windowed for the UI.
  const selectedTools = bounded ? selectTools(state.tools, startRawIndex, toolLimit) : state.tools;
  const tools = selectedTools.map((tool) => {
    const rawAfter = Math.max(0, Number(tool.after) || 0);
    const mapped = bounded
      ? (rawAfter < startRawIndex ? 0 : (visibleAfter.has(rawAfter) ? visibleAfter.get(rawAfter) : messages.length - 1))
      : (rawAfter < visibleAfter.length ? visibleAfter[rawAfter] : messages.length - 1);
    let normalized = tool.state === 'running' ? null : cache.tools.get(tool);
    if (!normalized) {
      normalized = { ...tool };
      // Complete snapshots remain suitable for archive/handoff; only the UI
      // projection below defers large receipts to the on-demand IPC endpoint.
      if (tool.state !== 'running') cache.tools.set(tool, normalized);
    }
    return { ...(bounded ? toolDetail.project(tool) : normalized), after: Math.max(0, mapped) };
  });
  const result = {
    // Accounting must include hidden audit/tool-only responses and every
    // continuation receipt. The presentation transcript intentionally merges
    // or hides these rows and cannot be used as a financial ledger.
    ...(!bounded ? { usageReceipts: accountingReceipts(state, cache) } : {}),
    status: deriveStatus(state),
    statusText: statusText(state),
    modelRetry: state.modelRetry ? { ...state.modelRetry } : null,
    // ?????????????????????????? role ?????????????????????????????????
    messages,
    // Bounded owners use history.messageIndices. Full snapshots have no raw
    // index map and are also persisted as visible runtime-handoff prefixes.
    turnMetrics: injectTurnCumulatives(bounded, metrics.finish(), state, cache, visibleAfter),
    tools,
    toolPreparations: preparation.list(state).map(row => ({ ...row, after: Math.max(0,
      (bounded ? visibleAfter.get(row.after) : visibleAfter[row.after]) ?? messages.length - 1) })),
    notices: state.notices.map((item) => ({
      message: item.message, level: item.level, count: item.count,
      at: item.at, scope: item.scope,
    })),
    usage: state.usage,
    usageSummary: usageSummary(state, cache),
    contextUsage: state.contextUsage,
    pendingUi: state.pendingUi,
    completion: {
      reason: state.lastStopReason,
      rawReason: state.rawStopReason,
      incomplete: deriveStatus(state) === 'incomplete',
      incompleteReason: state.incompleteReason || (state.lastStopReason === 'length' ? 'length' : ''),
      error: modelErrors.forDisplay(state.lastAssistantError, 200, state.lastErrorAfterToolResult),
      // Recovery must not parse localized display text (network errors have no HTTP code).
      retryable: state.lastStopReason === 'error' && modelErrors.describe(state.lastAssistantError).retryable,
      authExpired: state.lastStopReason === 'error' && modelErrors.describe(state.lastAssistantError).authExpired,
      protocolIssue: state.protocolIssue ? {
        code: state.protocolIssue.code,
        count: state.protocolIssue.count,
        parameters: state.protocolIssue.parameters,
      } : null,
    },
  };
  if (bounded) {
    result.history = {
      truncated: startRawIndex > 0 || state.tools.length > tools.length,
      totalMessages: state.messages.length,
      totalTools: state.tools.length,
      loadedMessages: messages.length,
      loadedTools: tools.length,
      messageStart: startRawIndex,
      messageLimit, messageIndices,
    };
  }
  return result;
}

module.exports = { snapshot };
