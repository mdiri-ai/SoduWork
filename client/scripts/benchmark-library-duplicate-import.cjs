'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { pathToFileURL } = require('node:url');

async function main() {
  const count = 1500, root = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-duplicate-import-'));
  try {
    const owner = 'a'.repeat(32), handlers = new Map();
    const sender = { mainFrame: {}, isDestroyed: () => false,
      getURL: () => pathToFileURL(path.resolve(__dirname, '../desk.html')).href };
    require('../main/library-local.cjs').install({
      app: { getPath: () => root }, ownerOf: () => owner,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    });
    const call = (action, payload = {}) => handlers.get('library-local-call')(
      { sender, senderFrame: sender.mainFrame }, action, { owner, ...payload });
    const bytes = Buffer.from('synthetic imported report');
    await call('upload', { name: 'report.txt', dataBase64: bytes.toString('base64') });
    const account = path.join(root, 'SoduWorkLibrary', 'accounts', owner);
    const indexPath = path.join(account, 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')), original = index.items[0];
    for (let number = 1; number < count; number++) {
      const uuid = crypto.randomUUID(), filename = `report（${number}）.txt`;
      const key = `objects/${uuid}/${filename}`, target = path.join(account, key);
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
      index.items.push({ ...original, id: 'local-' + uuid, filename, title: filename, _object: key });
    }
    const initialIndex = JSON.stringify(index), milliseconds = [], normalizationCounts = [];
    let outcome;
    for (let run = 0; run < 5; run++) {
      fs.writeFileSync(indexPath, initialIndex);
      const normalize = String.prototype.normalize; let comparisons = 0;
      String.prototype.normalize = function (...args) { comparisons++; return Reflect.apply(normalize, this, args); };
      let result;
      try {
        const start = performance.now();
        result = await call('upload', { name: 'report.txt', dataBase64: bytes.toString('base64') });
        milliseconds.push(performance.now() - start);
      } finally { String.prototype.normalize = normalize; }
      normalizationCounts.push(comparisons);
      const saved = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      const row = saved.items.find(item => item.id === result.item.id);
      const imported = fs.readFileSync(path.join(account, row._object));
      if (row.filename !== `report（${count}）.txt` || !imported.equals(bytes) || saved.items.length !== count + 1) {
        throw Error('Import changed the filename, contents or item count');
      }
      outcome = { filename: row.filename, bytes: imported.length, items: saved.items.length,
        sha256: crypto.createHash('sha256').update(imported).digest('hex') };
      fs.rmSync(path.dirname(path.join(account, row._object)), { recursive: true });
    }
    console.log(JSON.stringify({ existingFiles: count, milliseconds,
      medianMilliseconds: [...milliseconds].sort((a, b) => a - b)[2], normalizationCounts, outcome }, null, 2));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
