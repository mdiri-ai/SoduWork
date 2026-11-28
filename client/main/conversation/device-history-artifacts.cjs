'use strict';

// This receipt stays on the originating desktop. A conversation, model reply,
// or renderer filename cannot grant access to another workspace.
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./delivery-contract');
const versions = require('./runtime-artifacts.cjs');
const { assertNoLinks } = require('../plugin-resources');
const { excludedName, portablePath, MAX_BYTES: MAX_TRANSFER_BYTES } = require('./portable-workspace');
const packages = require('./device-history-plugins.cjs');
const drafts = require('../pi-session/plugin-draft-candidates');
const realpath = fs.realpathSync.native || fs.realpathSync;
const webResource = /\.(?:css|m?js|woff2?|ttf|ico|wasm|mp3|wav|ogg|svg)$/i;
const epoch = value => Number.isFinite(value) && value > 0 ? (value < 1e11 ? value * 1000 : value) : 0;

function eligible(relative, includePackageResources = false) {
  try { portablePath(relative); } catch (_) { return false; }
  if (/^\.soduwork\/evidence\/[^/.][^/]*\.(?:png|jpe?g|gif|webp)$/i.test(relative)) return true;
  return !relative.split('/').some(part => part.startsWith('.') || excludedName(part)) &&
    Boolean(contract._kindOf(relative) || webResource.test(relative) || drafts.ARCHIVE.test(relative) ||
      includePackageResources && packages.resource(relative));
}

const deliverable = name => contract._kindOf(name) || (drafts.ARCHIVE.test(name) ? 'archive' : '');

function allocation(row, workRoot, workspace) {
  if (!workRoot || workspace?.id !== row.id || !workspace.cwd || row.cwd !== workspace.cwd) return null;
  const name = path.basename(row.cwd);
  if (workspace.taskId !== name || !/^chat-(?:[a-z0-9]+-[a-z0-9]{4,6}|[a-f0-9-]{36})$/.test(name)) return null;
  const root = realpath(workRoot), expected = path.join(root, 'temp', name);
  assertNoLinks(root, expected);
  // The application's configured work root may itself be an OS alias (for
  // example /var on macOS). Descendants within its allocation stay link-free.
  const canonical = realpath(expected);
  const configured = path.resolve(row.cwd) === path.resolve(workRoot, 'temp', name) && realpath(row.cwd) === canonical;
  if (!configured && !matchesJournalRoot(canonical, row.cwd)) return null;
  const start = epoch(workspace.started), end = epoch(workspace.ended);
  return start && end >= start && end <= Date.now() ? { start, end, inclusiveMillisecond: workspace.endedPrecisionMs === 1 && Number.isSafeInteger(end) } : null;
}

function stable(root, relative) {
  if (!eligible(relative, true)) return null;
  const target = path.join(root, relative);
  try {
    assertNoLinks(root, target);
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || path.relative(target, realpath(target))) return null;
    return stat;
  } catch (_) { return null; }
}

function during(stat, window) {
  // The Pi JSONL timestamp covers its entire final millisecond. Keep the
  // higher-resolution interval used by Runner receipts when available.
  function within(nanos) {
    const ms = Number(nanos) / 1e6;
    return ms >= window.start && (window.inclusiveMillisecond ? Number(nanos / 1000000n) <= window.end : ms <= window.end);
  }
  return within(stat.ctimeNs) && within(stat.mtimeNs);
}

function classify(root, files, window, snapshot, executionCwd) {
  // Only classify verified file identities. Even a valid manifest cannot add
  // paths absent from this inventory, or grant a renderer directory access.
  let primary;
  const processFiles = new Set();
  let references, wantsCaptures;
  if (snapshot) {
    const selection = require('./delivery-selection');
    const { request, answer } = selection.turn(snapshot);
    references = contract.replyReferences(root, answer);
    wantsCaptures = selection.requestsCaptures(request);
    if (!wantsCaptures) {
      const captures = require('./screenshot-evidence').capturePaths(executionCwd || root, snapshot, references.previews);
      for (const file of files) {
        if (captures.has(process.platform === 'win32' ? file.path.toLowerCase() : file.path)) processFiles.add(file.relative);
      }
    }
  }
  const start = epoch(snapshot?.startedAt);
  const manifestWindow = window || (start && { start, end: Date.now() + 1 });
  if (manifestWindow) try {
    const manifest = path.join(root, contract.MANIFEST_RELATIVE);
    assertNoLinks(root, manifest);
    const stat = fs.lstatSync(manifest, { bigint: true });
    // A verified turn already proves every candidate's bytes through its journal.
    // An in-place manifest rewrite can retain an older ctime on Windows.
    const modified = Number(stat.mtimeNs) / 1e6;
    const current = window ? during(stat, window) : modified >= start && modified <= manifestWindow.end;
    if (!stat.isFile() || stat.nlink !== 1n || !current) throw Error('Unverified delivery manifest');
    const verified = require('./metadata-snapshot.cjs').read(root, manifest, { maxBytes: 256 * 1024 });
    if (!versions.same(versions.stamp(stat), versions.stamp(verified.stat))) throw Error('Delivery manifest changed');
    const parsed = JSON.parse(verified.bytes);
    if (parsed.schemaVersion === 1 && Array.isArray(parsed.deliverables)) {
      const byPath = new Map(files.map(file => [file.relative, file]));
      for (const name of Array.isArray(parsed.processFiles) ? parsed.processFiles : []) {
        if (byPath.has(name)) processFiles.add(name);
      }
      for (const spec of parsed.deliverables) {
        const name = spec?.path || spec?.entry;
        if (byPath.has(name) && versions.recordedEvidence({ relative: name, role: spec.role })) processFiles.add(name);
      }
      primary = new Map((parsed.presentation === 'summary' ? [] : parsed.deliverables)
        .filter(spec => spec && byPath.has(spec.path || spec.entry) && spec.primary !== false)
        .map(spec => [spec.path || spec.entry, { title: String(spec.title || '').slice(0, 160) }]));
    }
  } catch (_) { /* Legacy workspaces may have no manifest. */ }
  if (!primary) {
    primary = new Map(contract.infer(files, root).items.map(file => [file.relative, file]));
    if (references?.linked.size) {
      const nominated = contract.fromReply(root, snapshot, { files: files.map(file => ({ ...file, changedInTurn: true })) }, references);
      for (const file of nominated.delivery?.items || []) {
        if (file.kind === 'image') primary.set(file.relative, file);
      }
    }
  }
  return files.map(file => {
    const declared = primary.get(file.relative), kind = deliverable(file.relative) || 'file';
    const evidence = processFiles.has(file.relative) || versions.recordedEvidence(file) || (!declared && contract._isProcess(file));
    return { ...file, ...declared, kind, artifactId: contract._artifactId(kind, file.relative),
      title: declared?.title || file.name, primary: Boolean(declared) && !evidence,
      preview: ['website', 'image', 'video', 'pdf'].includes(kind),
      processEvidence: evidence };
  });
}

function matchesJournalRoot(root, cwd) {
  if (cwd === root) return true;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) return false;
  try {
    // Older Windows receipts can use an 8.3 spelling for the same directory.
    // Check the original path before resolving it so a junction cannot bind a receipt.
    const supplied = path.resolve(cwd);
    assertNoLinks(path.parse(supplied).root, supplied);
    return realpath(supplied) === root;
  } catch (_) { return false; }
}

async function journalFiles(root, journal, maxFileBytes) {
  if (!journal?.turnId || journal.truncated || !Array.isArray(journal.files) || !matchesJournalRoot(root, journal.cwd)) return [];
  const files = [];
  for (const change of journal.files) {
    const receipt = change.after, relative = change.path;
    if (!['created', 'modified', 'renamed'].includes(change.action) || !receipt?.exists || receipt.path !== relative ||
        !/^[a-f0-9]{64}$/.test(receipt.hash) || !eligible(relative, true)) continue;
    const stat = stable(root, relative);
    if (!stat || Number(stat.size) !== receipt.size || stat.size > maxFileBytes) continue;
    const file = path.join(root, relative), stamp = versions.stamp(stat);
    let fd;
    try {
      fd = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      if (!versions.same(stamp, versions.stamp(await fd.stat({ bigint: true })))) continue;
      const hash = require('node:crypto').createHash('sha256');
      for await (const chunk of fd.createReadStream({ autoClose: false })) hash.update(chunk);
      const current = stable(root, relative);
      if (!current || !versions.same(stamp, versions.stamp(current)) || hash.digest('hex') !== receipt.hash) continue;
      files.push({ path: file, relative, name: path.basename(file), size: receipt.size,
        at: Math.round(Number(stat.mtimeNs) / 1e6), verifiedStamp: stamp });
    } catch (_) { /* A replaced file cannot satisfy a completed content receipt. */ }
    finally { await fd?.close().catch(() => {}); }
  }
  return files;
}

async function capture({ row, workRoot, workspace, previous, retained, journal, verifiedTransfer = false, verifiedTurn = false, nativePiEvidence = false, recheckPiEvidence = false, snapshot, executionCwd }) {
  if (!row.cwd || !path.isAbsolute(row.cwd)) return null;
  let root;
  try { root = realpath(row.cwd); } catch (_) { return previous || null; }
  const prior = previous?.root === root ? previous : null;
  const records = new Map([...(prior?.items || []), ...(prior?.resources || [])]
    .filter(entry => eligible(entry.metadata?.relative, true)).map(entry => [entry.metadata.relative, entry]));
  // A later segment may have produced a new version under the same relative
  // name. Keep its receipt only when it authenticates the file that exists now.
  if (retained?.root === root) for (const entry of [...(retained.items || []), ...(retained.resources || [])]) {
    const relative = entry.metadata?.relative;
    if (!eligible(relative, true)) continue;
    const older = records.get(relative);
    if (older && versions.same(older.stamp, entry.stamp)) continue;
    const stat = stable(root, relative);
    if (stat && versions.same(entry.stamp, versions.stamp(stat))) {
      // A retained segment can prove a file revision but cannot assign that
      // revision to a message in a different execution segment.
      const { turnId, userMessageIndex, ...source } = entry.source || {};
      records.set(relative, turnId || userMessageIndex !== undefined ? { ...entry, source } : entry);
    }
  }
  let window;
  try { window = allocation(row, workRoot, workspace); } catch (_) { /* A removed or relinked directory is unavailable. */ }
  const files = [];
  const recordedUntil = recheckPiEvidence ? 0 : prior?.recordedUntil || 0;
  const packageUntil = recheckPiEvidence ? 0 : prior?.packageRecordedUntil || 0;
  if (window && window.end > Math.min(recordedUntil, packageUntil)) {
    const since = Math.min(recordedUntil, packageUntil);
    const inventory = await require('../pi-session/outputs').inventoryAsync(root, Math.max(window.start, since));
    const evidence = require('./screenshot-evidence').collect(root, { since: window.start, until: window.end });
    for (const candidate of [...inventory, ...evidence]) {
      const relative = path.relative(root, candidate.path).split(path.sep).join('/');
      const stat = stable(root, relative);
      if (!stat) continue;
      const until = drafts.ARCHIVE.test(relative) || !eligible(relative) ? packageUntil : recordedUntil;
      if (!during(stat, window) || until && Number(stat.mtimeNs) / 1e6 <= until) continue;
      files.push({ ...candidate, relative, verifiedStamp: versions.stamp(stat) });
    }
  }
  const completeJournal = journal?.turnId && !journal.truncated && Array.isArray(journal.files) && matchesJournalRoot(root, journal.cwd);
  // A passive refresh can see the journal before the runtime's terminal callback.
  // Recheck those bytes when binding them to an authenticated turn.
  const alreadyCaptured = !recheckPiEvidence && completeJournal && journal.turnId === prior?.turnId && journal.turnId === prior?.packageTurnId;
  let pending = completeJournal && (!alreadyCaptured || verifiedTurn) ? journal : null;
  if (nativePiEvidence && alreadyCaptured && !verifiedTurn) {
    const files = journal.files.filter(change => change.piTurn &&
      records.get(change.path)?.source?.turnId !== change.piTurn.turnId);
    if (files.length) pending = { ...journal, files };
  }
  const changes = pending ? await journalFiles(root, pending, verifiedTransfer ? BigInt(MAX_TRANSFER_BYTES) : 32n * 1024n * 1024n) : [];
  const turnFiles = new Map(changes.map(file => [file.relative, file.verifiedStamp]));
  const piChanges = new Map(nativePiEvidence && !verifiedTransfer ? journal?.files?.map(change => [change.path, change]) : []);
  files.push(...changes);
  if (files.length) {
    const expected = new Map(files.map(file => [file.relative, file.verifiedStamp]));
    const indexed = versions.capture(root, { items: classify(root, files, window, verifiedTurn && snapshot, executionCwd) }, { sessionId: row.id, adapterId: row.adapterId });
    for (const entry of indexed.items) {
      const relative = entry.metadata.relative;
      if (!versions.same(expected.get(relative), entry.stamp)) continue;
      const change = piChanges.get(relative);
      const owner = verifiedTurn && !verifiedTransfer ? journal : change?.piTurn;
      if (owner?.turnId && versions.same(turnFiles.get(relative), entry.stamp)) {
        entry.source = { ...entry.source, turnId: owner.turnId };
        if (change?.piEditBaseSha256)
          entry[require('./pi-history-artifacts.cjs').VERIFIED_EDIT_BASE] = change.piEditBaseSha256;
        if (verifiedTurn && row.deliveryWorkspaceKey && path.basename(root) === row.deliveryWorkspaceKey &&
            path.basename(path.dirname(root)) === '.soduwork-drafts')
          entry.source.deliveryWorkspaceKey = row.deliveryWorkspaceKey;
        if (Number.isSafeInteger(owner.userMessageIndex) && owner.userMessageIndex >= 0)
          entry.source.userMessageIndex = owner.userMessageIndex;
      }
      const recorded = records.get(relative);
      if (recorded && versions.same(recorded.stamp, entry.stamp)) {
        if (!entry.source?.turnId) entry.source = recorded.source;
        // A journal proves the bytes. Its metadata may omit the tool's screenshot role.
        if (versions.recordedEvidence(recorded.metadata)) {
          entry.metadata.processEvidence = true;
          entry.metadata.primary = false;
        }
      }
      // The allocation ties a shell-produced original to this chat, but only
      // its own native write receipt can bind it to a particular message.
      if (!entry.source?.turnId && entry.source?.adapterId === 'pi' && window?.inclusiveMillisecond &&
          require('./legacy-upgrade-artifacts.cjs').media(entry))
        entry.source = { ...entry.source, turnId: require('./artifact-versions.cjs').unassignedTurn(entry) };
      records.set(relative, entry);
    }
  }
  if (!records.size && !window) return null;
  const all = [...records.values()];
  return { version: 1, packageRecordedUntil: Math.max(window?.end || 0, prior?.packageRecordedUntil || 0),
    packageTurnId: (completeJournal && journal.turnId) || prior?.packageTurnId || '', root, items: all.filter(entry => deliverable(entry.metadata.relative)),
    resources: all.filter(entry => !deliverable(entry.metadata.relative)),
    recordedUntil: Math.max(window?.end || 0, prior?.recordedUntil || 0), turnId: journal?.turnId || prior?.turnId || '' };
}

function view(cwd, history, guard, authorize = guard) {
  const byPath = new Map();
  const cards = new Map(), receipts = new Map();
  for (const row of [...(history?.items || []), ...(history?.resources || [])]) {
    if (row.archiveOnly) continue;
    if (eligible(row.metadata?.relative, true)) receipts.set(row.metadata.relative, row.stamp);
    if (!eligible(row.metadata?.relative)) continue;
    byPath.set(path.resolve(cwd, row.metadata.relative), row);
    byPath.set(path.resolve(history.root, row.metadata.relative), row);
  }
  function matches(target, stat) {
    const record = byPath.get(target);
    if (!record) return false;
    try { if (realpath(cwd) !== history.root) return false; } catch (_) { return false; }
    const current = stable(history.root, record.metadata.relative);
    return Boolean(current && versions.same(record.stamp, versions.stamp(current)) &&
      (!stat || versions.same(record.stamp, versions.stamp(stat))));
  }
  function snapshot() {
    guard();
    const items = versions.restore(cwd, history).filter(item => matches(item.path))
      .map(item => ({ ...item, primary: item.historicalPrimary, pluginDraft: false }));
    const candidates = items.filter(item => cards.get(item.relative)).map(item => {
      const card = cards.get(item.relative);
      Object.assign(item, card, { pluginRevisionAt: card.pluginRevisionAt || item.at, pluginSuperseded: false });
      if (card.pluginValidation.state === 'ready' && !verifyPlugin(item))
        item.pluginValidation = { ...card.pluginValidation, state: 'invalid', diagnostic: { message: '随包文件已改变，请重新生成' } };
      return item;
    });
    const selected = new Set(drafts.mergePluginCandidates(candidates));
    for (const item of candidates) {
      if (!selected.has(item)) item.pluginDraft = false;
      else if (!item.pluginKey && item.pluginIdentity?.includes(item.path.toLowerCase()))
        item.pluginIdentity = 'draft-file:' + item.artifactId;
    }
    const delivery = { schemaVersion: 1, source: 'history', items: items.filter(item => item.primary && !item.processEvidence) };
    return { got: { files: [], delivery }, items, delivery };
  }
  async function snapshotAsync() {
    await authorize();
    const initial = snapshot();
    const files = initial.items.filter(item => (drafts.SKILL_ARCHIVE.test(item.relative) || packages.candidate(item.relative)) && !cards.has(item.relative))
      .map(item => ({ relative: item.relative, stamp: item.historicalVersion }));
    if (!files.length) return initial;
    const skillRuntimeEntry = require('./skill-frontmatter').runtimeEntry(undefined, true);
    const checked = new Map();
    // Limit each worker request to a few packages and their recorded resources.
    // A busy worker must not hide unrelated files when the chat is reopened.
    for (let i = 0; i < files.length; i += 8) {
      const batch = files.slice(i, i + 8);
      let inspected;
      try {
        inspected = await require('../app-resource-cache.cjs').request({ action: 'history-package-cards', root: history.root,
          files: batch, receipts: packageReceipts(batch), skillRuntimeEntry });
      } catch (_) { continue; }
      guard();
      for (const file of batch) checked.set(file.relative, null);
      for (const card of inspected) checked.set(card.relative, card);
    }
    await authorize();
    for (const [name, card] of checked) cards.set(name, card);
    return snapshot();
  }
  function readSkill(item) {
    guard();
    const record = byPath.get(item.path);
    if (!record || record.metadata.artifactId !== item.artifactId || !matches(item.path)) throw Error('技能包已改变');
    return require('./device-history-skills.cjs').read(history.root, record.metadata.relative, record.stamp);
  }
  function packageReceipts(files) {
    const manifests = files.map(file => file.relative).filter(packages.candidate);
    if (!manifests.length) return [];
    const dirs = manifests.filter(name => !drafts.ARCHIVE.test(name)).map(name => path.posix.dirname(name));
    return [...receipts].filter(([name]) => manifests.includes(name) || packages.BASELINE.test(name) ||
      dirs.some(dir => {
        const relative = path.posix.relative(dir, name);
        return !relative.startsWith('../') && packages.resource(relative);
      }));
  }
  function verifyPlugin(item) {
    guard();
    if (!matches(item.path)) return false;
    return (cards.get(item.relative)?.dependencies || []).every(name => {
      const stat = stable(history.root, name);
      return stat && versions.same(receipts.get(name), versions.stamp(stat));
    });
  }
  async function readPlugin(item) {
    guard();
    if (!packages.candidate(item.relative) || !verifyPlugin(item) || byPath.get(item.path)?.metadata.artifactId !== item.artifactId)
      throw Error('插件成果已改变');
    return require('../app-resource-cache.cjs').request({ action: 'read-history-package', root: history.root,
      relative: item.relative, receipts: packageReceipts([item]), skillRuntimeEntry: require('./skill-frontmatter').runtimeEntry(undefined, true) });
  }
  return { verify(target, stat) { guard(); return matches(target, stat); }, snapshot, snapshotAsync, readSkill, readPlugin, verifyPlugin, authorize };
}

function archivedView(profile, id, cwd, history, guard, authorize) {
  const original = view(cwd, history, guard, authorize);
  const saved = require('./device-artifact-archive.cjs').projection(profile, id, history);
  if (!saved?.items.length) return original;
  const archived = view(saved.root, saved, guard, authorize);
  function combine(live, copy) {
    // A larger or unavailable replacement may have kept the prior archived
    // revision. Prefer the newer original only while its own receipt verifies.
    const fallbackNames = new Set(history.items.filter(row => row.archiveOnly).map(row => row.metadata.relative));
    const liveReplacements = new Set(live.items.filter(row => fallbackNames.has(row.relative)).map(row => row.relative));
    const archivedItems = copy.items.filter(row => !liveReplacements.has(row.relative));
    const present = new Set(archivedItems.map(row => row.relative));
    const items = [...archivedItems, ...live.items.filter(row => !present.has(row.relative))];
    const delivery = { ...copy.delivery, items: items.filter(row => row.primary && !row.processEvidence) };
    return { ...copy, items, delivery, got: { ...copy.got, delivery } };
  }
  const owner = item => archived.verify(item.path) ? archived : original;
  return { authorize,
    verify: (file, stat) => archived.verify(file, stat) || original.verify(file, stat),
    snapshot() {
      const copy = archived.snapshot();
      return copy.items.length === history.items.length ? copy : combine(original.snapshot(), copy);
    },
    async snapshotAsync() {
      const copy = await archived.snapshotAsync();
      return copy.items.length === history.items.length ? copy : combine(await original.snapshotAsync(), copy);
    },
    readSkill: item => owner(item).readSkill(item),
    readPlugin: item => owner(item).readPlugin(item),
    verifyPlugin: item => owner(item).verifyPlugin(item) };
}

module.exports = { capture, view, archivedView, matchesJournalRoot, eligible };
