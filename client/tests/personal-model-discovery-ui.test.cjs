'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('personal model discovery routes hub services through the client API', () => {
  const api = read('api.js');
  assert.match(api, /async discoverMyModels\(providerId\)/);
  assert.match(api, /\/my-models\/' \+ encodeURIComponent\(nativeId\) \+ '\/discover/);
  // The origin check must use the same management authority as the write path.
  assert.match(api, /discoverMyModels[\s\S]{0,900}requirePersonalProvider/);
});

test('model panel offers discovery only for hub personal services', () => {
  const panel = read('components', 'panels', 'panels-models.js');
  assert.match(panel, /p\.localOnly !== true \? '<div class="md-discover-bar"/);
  assert.match(panel, /data-pdiscover=/);
  assert.match(panel, /async function _mdDoDiscover/);
  assert.match(panel, /function _mdApplyDiscover/);
  // Imported names follow the editable model-row shape.
  assert.match(panel, /_mdMyModels\.push\(\{ providerId: pid, name, label: name, modality: 'chat', config: \{\} \}\)/);
  // Duplicates are filtered against both the edit list and saved definitions.
  assert.match(panel, /_mdMyModels\.some\(row => row\.providerId === pid && row\.name === name\)/);
  assert.match(panel, /_mdCatalogModels\(provider\)\.some\(row => row\.name === name\)/);
  // Adding marks the provider dirty so the normal save path persists it.
  assert.match(panel, /if \(added > 0\) _mdMarkOwnedDirty\(provider \|\| pid\)/);
});

test('device-local services keep using the connection-test auto-discovery', () => {
  const api = read('api.js');
  assert.match(api, /本地服务会在测试连接时自动读取模型列表/);
});
