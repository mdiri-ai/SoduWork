'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { epoch } = require('./message-time');
const { resolveToolPath } = require('../access-control/policy');
const { portablePath } = require('./portable-workspace');
const { publishedDirectory } = require('./delivery-workspace.cjs');

const VERSION = 3;
const VERIFIED_EDIT_BASE = Symbol('verified Pi edit base');
const limits = require('./file-change-journal').DEFAULTS;

function absolute(value, paths) {
  if (typeof value !== 'string' || !paths.isAbsolute(value) || value.split(/[\\/]/).includes('..')) return;
  if (paths === path.win32 && paths.parse(value).root.length < 3) return;
  const resolved = paths.resolve(value);
  return paths === path.win32 ? resolved.replace(/^[a-z]:/i, drive => drive.toUpperCase()) : resolved;
}
function sameWorkspace(left, right, paths = path) {
  const native = absolute(left, paths), indexed = absolute(right, paths);
  if (!native || !indexed) return false;
  if (native === indexed) return true;
  if (paths !== path || process.platform !== 'win32' ||
      path.parse(native).root.toLowerCase() !== path.parse(indexed).root.toLowerCase()) return false;
  // Case-sensitive NTFS directories can have distinct siblings that differ
  // only by case. Both original spellings must lead to the same link-free root.
  try {
    const root = require('node:fs').realpathSync.native(indexed);
    const { matchesJournalRoot } = require('./device-history-artifacts.cjs');
    return matchesJournalRoot(root, indexed) && matchesJournalRoot(root, native);
  } catch (_) { return false; }
}
function targetInWorkspace(cwd, indexed, file) {
  // These two source roots must also pass sameWorkspace before any receipt is
  // returned. Resolve file names lexically: tool arguments never trigger I/O.
  for (const root of new Set([cwd, indexed])) {
    if (!absolute(root, path)) continue;
    const relative = path.relative(root, file);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) ||
        absolute(path.join(root, relative), path) !== absolute(file, path)) continue;
    return portablePath(relative.split(path.sep).join('/'));
  }
}
// Pi's edit tool matches all replacements against the original buffer. Replay
// only exact, unique matches; the caller still verifies the final bytes on disk.
function editedContent(previous, args, budget) {
  if (typeof previous !== 'string') return;
  const edits = args.edits ?? [args];
  if (!Array.isArray(edits) || !edits.length || edits.length > 128) return;
  // Charge complete passes before normalizing, searching or allocating the
  // result. The journal's limits bound one file and the entire native replay.
  let work = previous.length * (edits.length * 2 + 4);
  if (previous.length > limits.maxTextBytes) return;
  let output = previous.length;
  for (const edit of edits) {
    if (typeof edit?.oldText !== 'string' || !edit.oldText || typeof edit.newText !== 'string') return;
    work += edit.oldText.length + edit.newText.length * 3;
    output += Math.max(0, edit.newText.length - edit.oldText.length);
  }
  if (output > limits.maxTextBytes || work * 2 > budget.remaining) return;
  budget.remaining -= work * 2;
  const lf = s => s.replace(/\r\n?/g, '\n');
  const bom = previous.startsWith('\uFEFF') ? '\uFEFF' : '';
  const original = previous.slice(bom.length), text = lf(original);
  const spans = [];
  for (const edit of edits) {
    const old = lf(edit.oldText), start = text.indexOf(old);
    if (start < 0 || text.indexOf(old, start + 1) !== -1) return;
    spans.push({ start, end: start + old.length, value: lf(edit.newText) });
  }
  spans.sort((a, b) => a.start - b.start);
  let offset = 0;
  const chunks = [];
  for (const span of spans) {
    if (span.start < offset) return;
    chunks.push(text.slice(offset, span.start), span.value);
    offset = span.end;
  }
  chunks.push(text.slice(offset));
  const result = chunks.join('');
  if (result === text) return;
  return bom + (original.match(/\r?\n/)?.[0] === '\r\n' ? result.replace(/\n/g, '\r\n') : result);
}

// v1.13.19 did not persist Pi's workspace journal. A completed native write
// supplies the exact expected bytes, even for an explicitly selected project.
// Only completed calls in the current workspace can supply file identities.
function evidence(entries, row, revision, turns) {
  let cwd = entries[0].cwd, moved = false, lastMessage, piTurn;
  const completed = new Set(), calls = new Map(), written = new Map(), budget = { remaining: limits.maxHashBytes };
  for (const entry of entries) {
    if (entry.type === 'custom' && entry.customType === 'soduwork.workspace.moved' &&
        entry.data?.version === 1 && entry.data.cwd) {
      cwd = entry.data.cwd;
      moved = true;
      calls.clear();
      written.clear();
    }
    if (entry.type !== 'message' || !entry.message) continue;
    const message = entry.message;
    lastMessage = entry;
    if (message.role === 'user') {
      calls.clear();
      piTurn = turns.get(entry);
    }
    if (piTurn && message.role === 'assistant' && message.stopReason === 'stop') completed.add(piTurn);
    else if (piTurn && ['assistant', 'toolResult'].includes(message.role)) completed.delete(piTurn);
    if (message.role === 'assistant' && !['error', 'aborted', 'length'].includes(message.stopReason)) {
      for (const call of Array.isArray(message.content) ? message.content : []) {
        if (call?.type !== 'toolCall' || !call.id || !['write', 'edit'].includes(call.name)) continue;
        const args = call.arguments || {}, target = args.path;
        if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof target !== 'string' || !target ||
            target.split(/[\\/]/).includes('..')) continue;
        try {
          const file = resolveToolPath(call.name, target, cwd);
          const relative = targetInWorkspace(cwd, row.cwd, file);
          if (!relative) continue;
          const [parent, key] = relative.split('/');
          if (!publishedDirectory(cwd, path.join(cwd, parent), key)) calls.set(call.id, { relative, args, piTurn, name: call.name });
        } catch (_) { /* The native target must resolve to a portable path in this workspace. */ }
      }
    }
    if (message.role !== 'toolResult') continue;
    const call = calls.get(message.toolCallId);
    calls.delete(message.toolCallId);
    if (!call || message.toolName !== call.name || message.isError !== false ||
        message.details?.soduWorkAccessChange?.state === 'cancelled') continue;
    const { relative, args } = call;
    const old = written.get(relative), edited = call.name === 'edit';
    const content = edited ? editedContent(old?.content, args, budget) : args.content;
    if (typeof content !== 'string') { written.delete(relative); continue; }
    const sameTurnEdit = edited && old?.piTurn?.turnId && old.piTurn === call.piTurn;
    const base = sameTurnEdit ? (old.edited ? old.base : crypto.createHash('sha256').update(old.content).digest('hex')) : undefined;
    written.set(relative, { content, piTurn: call.piTurn, edited, base });
  }
  if (!sameWorkspace(cwd, row.cwd)) return {};
  const files = Array.from(written, ([relative, { content, piTurn, edited, base }]) => ({
    // An intermediate edit must not claim the turn's immutable final version.
    ...(piTurn && (!edited || completed.has(piTurn)) ? { piTurn } : {}),
    ...(base && completed.has(piTurn) ? { piEditBaseSha256: base } : {}), action: 'modified', path: relative, after: { path: relative, exists: true,
      size: Buffer.byteLength(content), hash: crypto.createHash('sha256').update(content).digest('hex') },
  }));
  const localJournal = files.length ? { cwd: row.cwd, turnId: 'pi-archive:' + revision, files } : undefined;
  // A scratch ref in the old local replica is independent of the archive's
  // cwd. Both must agree before inventorying shell-generated or binary files.
  // Explicit projects and moved/resumed scratch refs get only verified writes.
  const ended = epoch(lastMessage?.timestamp), started = epoch(entries[0].timestamp);
  const localWorkspace = !moved && row.ref === path.basename(cwd) && started && ended >= started &&
    lastMessage?.message.role === 'assistant' && lastMessage.message.stopReason === 'stop'
    ? { id: row.id, cwd: row.cwd, taskId: row.ref, started, ended, endedPrecisionMs: 1 } : undefined;
  return { localJournal, localWorkspace, artifactWorkspaceMatched: true };
}

module.exports = { VERSION, VERIFIED_EDIT_BASE, evidence, sameWorkspace };
