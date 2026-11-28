'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { unassignedTurn } = require('./artifact-versions.cjs');
const { stamp } = require('./runtime-artifacts.cjs');
const { root: deliveryRoot } = require('./delivery-workspace.cjs');
const { assertNoLinks } = require('../plugin-resources');

// A direct native reopen can expose the original website both from the output
// scanner and from an older backup without a turn. That backup's ID commits
// to the original file identity as well as the session and relative path.
function locate(session, current, archived) {
  if (!session.sessionId || session.historyArtifacts) return;
  const pending = archived.filter(file => file.kind === 'website' && file.primary &&
    !Number.isSafeInteger(file.userMessageIndex) && /^(?:pi|legacy)-archive:/.test(file.turnId) &&
    file.historicalSource?.sessionId === session.sessionId);
  if (!pending.length) return;
  const snapshot = session.snapshot?.(), messages = snapshot?.messages, history = snapshot?.history;
  if (!Array.isArray(messages) || messages.filter(m => m.role === 'user').length !== 1 ||
      history?.truncated || history?.messageStart > 0 || snapshot.historyRecovery?.incomplete ||
      (history?.totalMessages != null && history.totalMessages !== messages.length) ||
      history?.messageIndices?.some((absolute, index) => absolute !== index)) return;
  const reply = messages.length - 1;
  if (messages[reply]?.role !== 'assistant' || messages[reply].done === false) return;
  const working = new Map(current.map(file => [file.artifactId, file]));
  let root;
  try { root = deliveryRoot(session.cwd, session.deliveryWorkspace); }
  catch (_) { return; }
  for (const original of pending) {
    const file = working.get(original.originalArtifactId);
    if (!file?.primary || file.kind !== 'website' || file.changedInTurn || file.relative !== original.relative ||
        !file.path || path.resolve(root, original.relative) !== file.path) continue;
    try {
      assertNoLinks(root, file.path);
      const stat = fs.lstatSync(file.path, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) continue;
      const turn = unassignedTurn({ source: original.historicalSource, metadata: original, stamp: stamp(stat) });
      if (turn === original.turnId) original.legacyReplyIndex = reply;
    } catch (_) { /* An unavailable, linked or replaced working file cannot establish its owner. */ }
  }
}

module.exports = { locate };
