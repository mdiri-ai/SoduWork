'use strict';

const { declaredImages } = require('./kimi-history-images.cjs');
const versions = require('./artifact-versions.cjs');
const runtime = require('./artifact-runtime');

// Prepare the visible gallery independently of the full output index (which
// also opens package workers). A declaration can only filter existing receipts.
async function initial(options) {
  let expired = false, timer;
  const budget = new Promise(resolve => {
    timer = setTimeout(() => { expired = true; resolve([]); }, 250);
  });
  const guard = () => {
    if (expired) throw Error('Gallery prefetch expired');
    options.guards.guard();
  };
  const authorize = async () => {
    guard();
    await options.guards.authorize();
    guard();
  };
  try { return await Promise.race([budget, readInitial({ ...options, guards: { guard, authorize } })]); }
  finally { clearTimeout(timer); }
}

async function readInitial({ profile, row, history, view, guards, scope }) {
  const snapshot = view.snapshot(), names = new Set(), boundaries = new Set();
  let userIndex = snapshot.history?.leadingUserMessageIndex;
  for (const [index, message] of (snapshot.messages || []).entries()) {
    if (message.role === 'user')
      userIndex = snapshot.history?.messageIndices?.[index] ?? ((snapshot.history?.messageStart || 0) + index);
    if (message.role !== 'assistant') continue;
    const blocks = message.blocks?.length ? message.blocks.filter(block => block.kind === 'text') : [message];
    for (const block of blocks) {
      for (const name of declaredImages(block.text)) {
        names.add(name);
        if (Number.isSafeInteger(userIndex)) boundaries.add(userIndex);
      }
    }
  }
  if (!names.size || names.size > 100) return [];
  const matching = meta => meta?.kind === 'image' && (names.has(meta.relative) || names.has(meta.previewOf));
  const versionsInHistory = history.archive?.versions || [];
  const archived = versionsInHistory.filter(entry => !entry.resource && matching(entry.metadata));
  const items = (history.items || []).filter(entry => matching(entry.metadata));
  if ((!archived.length && !items.length) || archived.length + items.length > 256) return [];
  // The full index derives each turn's boundary from its first verified
  // receipt. Skip the shortcut if another receipt could change that boundary.
  const turns = new Map(archived.map(entry => [entry.turnId, entry.source?.userMessageIndex]));
  const owners = new Map(archived.filter(entry => Number.isSafeInteger(entry.source?.userMessageIndex))
    .map(entry => [entry.source.userMessageIndex, entry.turnId]));
  if (versionsInHistory.some(entry => {
    const index = entry.source?.userMessageIndex;
    return turns.has(entry.turnId) && turns.get(entry.turnId) !== index ||
      owners.has(index) && owners.get(index) !== entry.turnId;
  })) return [];
  // Version readers authorize both before and after asynchronous disk proofs.
  // Direct-only receipts need the same check before the synchronous snapshot.
  if (!archived.length) await guards.authorize();
  const groups = archived.length ? await versions.readers(profile, row.id, { versions: archived }, guards.guard, guards.authorize) : [];
  const originals = items.length ? require('./device-history-artifacts.cjs').archivedView(profile, row.id, row.cwd,
    { ...history, items, resources: [] }, guards.guard, guards.authorize) : null;
  guards.guard();
  const files = runtime.prepareHistoryGallery(view, groups, originals, scope);
  // A native Pi boundary overrides the user message's submission ID. Compare
  // against verified image receipts: a missing image cannot establish a turn.
  const verified = new Map(files.filter(file => file.versionId).map(file => [file.userMessageIndex, file.turnId]));
  if (versionsInHistory.some(entry => boundaries.has(entry.source?.userMessageIndex) &&
    entry.turnId?.startsWith('pi-history:') && verified.get(entry.source.userMessageIndex) !== entry.turnId)) return [];
  return files;
}

module.exports = { initial };
