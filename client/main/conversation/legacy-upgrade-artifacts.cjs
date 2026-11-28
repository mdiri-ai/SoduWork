'use strict';

const crypto = require('node:crypto');
const archive = require('./device-artifact-archive.cjs');
const versions = require('./artifact-versions.cjs');
const { same } = require('./runtime-artifacts.cjs');
const access = require('./history-access');
const { _kindOf } = require('./delivery-contract');

// Only self-contained formats can be pinned independently of a delivery's
// resource graph. Websites and packages use their existing source-specific writers.
function media(entry) {
  const meta = entry?.metadata;
  return meta?.artifactId && !meta.previewOf && !meta.pluginDraft && !meta.skillPackage &&
    /\.(?:png|jpe?g|gif|webp|pdf|docx?|pptx?|xlsx?|od[stp]|csv|mp4|webm|mov|m4v|ogv)$/i.test(meta.relative) &&
    _kindOf(meta.relative) === meta.kind;
}

function imagesWithoutReceipts(snapshot, history, items) {
  const names = new Set(items.map(entry => entry.metadata.relative));
  for (const entry of history?.archive?.versions || [])
    if (!entry.metadata?.previewOf) names.add(entry.relative);
  const missing = new Set();
  const { declaredImages } = require('./kimi-history-images.cjs');
  for (const message of snapshot?.messages || []) {
    if (message.role !== 'assistant' || message.done === false) continue;
    const body = message.blocks?.length ? message.blocks.filter(block => block.kind === 'text') : [message];
    for (const block of body)
      for (const relative of declaredImages(block.text))
        if (/\.(?:png|jpe?g|gif|webp)$/i.test(relative) && !names.has(relative)) missing.add(relative);
  }
  // Declarations only count an unavailable original. They never select a file to read.
  return missing.size;
}

// Runs after stock backfill has verified the native body and collected its local
// receipts. Publish only version references into the same private generation.
// A provisional ID deliberately carries no location in the conversation.
function unavailable(error) {
  // Path validation failures have no system code. Device, sharing and I/O
  // errors may recover and must leave this migration eligible to retry.
  if (error.code && !['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) throw error;
}

async function migrate({ app, row, store, data, assertCurrent }) {
  assertCurrent();
  if (data?.localArtifactHistory?.items?.some(media)) {
    const committed = await store.deviceHistory(row.id);
    assertCurrent();
    if (!committed?.digest || committed.digest !== data.digest)
      throw Object.assign(Error('历史成果已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
    data = committed;
  }
  const history = data?.localArtifactHistory;
  const items = (history?.items || []).filter(media);
  const result = { complete: true, digest: data?.digest, versionsAdded: 0,
    unavailable: imagesWithoutReceipts(data?.snapshot, history, items) };
  if (!items.length) return result;
  if (row.deleted || row.cached || row.deviceTransferId || data.imported || history.transferId ||
      data.historyProtection || !access.usesDeviceChatContext(app, { chatId: row.id }, row, data))
    return { ...result, unavailable: result.unavailable + items.length };
  const saved = history.archive;
  const profile = app.getPath('userData');
  let root;
  try { root = archive.location(profile, row.id, saved); }
  catch (error) { unavailable(error); }
  if (!root || !Array.isArray(saved.files)) return { ...result, unavailable: result.unavailable + items.length };

  const files = new Map(saved.files.map(file => [file.relative, file]));
  const key = (name, hash, at) => JSON.stringify([name, hash, at]);
  const known = new Set((saved.versions || []).filter(item => !item.resource)
    .map(item => key(item.relative, item.sha256, item.metadata.at)));
  const verified = [], receipts = [];
  for (const entry of items) {
    assertCurrent();
    const { metadata, source } = entry, name = metadata.relative, receipt = files.get(name);
    if (source?.sessionId !== row.id || !receipt || !same(entry.stamp, receipt.sourceStamp) ||
        !/^[a-f0-9]{64}$/.test(receipt.sha256) || !Number.isSafeInteger(metadata.size) ||
        metadata.size < 0 || String(metadata.size) !== receipt.stamp?.[2]) {
      result.unavailable++;
      continue;
    }
    const identity = key(name, receipt.sha256, metadata.at);
    if (known.has(identity)) continue;
    let bytes;
    try { bytes = await archive.readVersion(root, name, receipt.stamp); }
    catch (error) { unavailable(error); }
    assertCurrent();
    if (!bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) {
      result.unavailable++;
      continue;
    }
    // A verified native receipt may already name a turn. For directory-only
    // evidence, use the same stable, unassigned address as the released client.
    const owner = source.turnId ? source : { sessionId: row.id, adapterId: source.adapterId, turnId: versions.unassignedTurn(entry) };
    verified.push({ ...entry, source: owner, stamp: receipt.stamp, archiveOnly: false });
    receipts.push({ ...receipt, sourceStamp: receipt.stamp });
    known.add(identity);
  }
  const current = { ...saved, files: receipts };
  if (verified.length && versions.record(current, saved, { root, items: verified }, [])) {
    const { digest, savedAt, ...body } = data;
    const localArtifactHistory = { ...history, archive: { ...saved, versions: current.versions } };
    assertCurrent();
    const write = await store.saveDeviceHistory(row.id, { ...body, localArtifactHistory }, {
      expectedRevision: row.replicaRevision, expectedTransferId: '', expectedHistoryDigest: digest,
    });
    assertCurrent();
    if (!write.ok) throw Object.assign(Error('历史成果已变化，请重新读取'), { code: 'HISTORY_CONCURRENT_UPDATE' });
    result.versionsAdded = current.versions.length - (saved.versions || []).length;
    result.digest = write.digest;
  }
  return result;
}

module.exports = { migrate, media };
