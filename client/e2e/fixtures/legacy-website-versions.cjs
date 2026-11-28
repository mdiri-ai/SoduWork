'use strict';

const fs = require('node:fs');
const path = require('node:path');
const archive = require('../../main/conversation/device-artifact-archive.cjs');
const versions = require('../../main/conversation/artifact-versions.cjs');
const artifacts = require('../../main/conversation/device-history-artifacts.cjs');
const runtime = require('../../main/conversation/artifact-runtime');
const changes = require('../../main/conversation/file-change-journal');
const conversation = require('../../main/agent-runtime/switchable-conversation');
const outputs = require('../../main/pi-session/outputs');

module.exports = async function websiteVersions(root) {
  const profile = path.join(root, 'archives'), cwd = path.join(root, 'old-project'), copy = path.join(root, 'copied-project');
  for (const directory of [profile, cwd, copy]) fs.mkdirSync(directory);
  const id = 'single-site', file = path.join(cwd, 'index.html'), guard = () => {};
  const user = { role: 'user', blocks: [{ kind: 'text', text: '制作网页' }] };
  const assistant = { role: 'assistant', done: true, blocks: [{ kind: 'text', text: '已完成 index.html，可以继续编辑 index.html。' }] };
  const before = await changes.snapshot(cwd);
  fs.writeFileSync(file, '<title>LUMEN STUDIO</title><h1>original</h1>');
  const old = changes.compare(before, await changes.snapshot(cwd), { turnId: 'old-inventory' });
  const row = { id, cwd, adapterId: 'pi' };
  const captured = await artifacts.capture({ row, journal: old, verifiedTurn: false });
  let saved = await archive.preserve(profile, id, captured, null, guard);
  saved = await versions.pinLegacyDeliveries(profile, id, saved, guard);

  async function index(directory, messages) {
    const handle = conversation.create({ options: {}, raw: { sessionId: id, adapterId: 'pi', cwd: directory,
      snapshot: () => ({ status: 'idle', messages, tools: [], turnMetrics: [] }),
      outputSnapshotAsync: () => outputs.scanAsync(directory, 0, 0) } });
    runtime.bindTurnArchives(handle, () => versions.readers(profile, id, saved.archive, guard));
    const { items } = await runtime.viewSnapshotAsync(handle);
    return { files: runtime.decorate(id, { items }, handle), snapshot: handle.snapshot() };
  }
  const single = [user, assistant];
  const original = await index(cwd, single);
  fs.copyFileSync(file, path.join(copy, 'index.html'));
  const copied = await index(copy, single);
  const baseline = await changes.snapshot(cwd);
  fs.writeFileSync(file, '<title>LUMEN STUDIO</title><h1>new site</h1>');
  const journal = changes.compare(baseline, await changes.snapshot(cwd), { turnId: 'second' });
  journal.userMessageIndex = 2;
  const changed = await artifacts.capture({ row, previous: saved, journal, verifiedTurn: true });
  saved = await archive.preserve(profile, id, changed, saved, guard);
  const second = await index(cwd, [user, assistant, { ...user, submissionId: 'second' }, assistant]);
  runtime.closeRef(id);
  return { original, copied, second };
};
