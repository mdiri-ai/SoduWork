'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { compile, describe } = require('./helpers/app-sdk-compiler.cjs');

const validConsumer = `
async function useApp(file: File, blob: Blob, signal: AbortSignal) {
  const app: SoduWorkApp.SDK = window.soduWorkApp;
  app.configure({parentOrigin: 'https://shell.example'});
  app.configure({allowedFrameOrigins: ['https://business.example']});
  const requestId: string = app.createRequestId();
  const version: string = app.version;
  const olderContext: SoduWorkApp.Context = {appId: 'app', contributionId: 'main', tabId: 'tab', activeConversationId: ''};
  const context = await app.context.get();
  if (context.ok) {
    const locale: string = context.locale ?? 'en-US';
    const appId: string = context.appId;
  }
  const user = await app.user.getCurrent();
  if (user.ok) { const id: string = user.user.id; }
  await app.notifications.list();
  const notices = await app.notifications.list({source: 'center', folder: 'received', offset: 0, limit: 20});
  if (notices.ok && notices.source === 'center') { const next: number | null = notices.nextOffset; }
  const materials = await app.library.list({storage: 'nfs', folderId: '', query: 'report'});
  if (materials.ok) { const next: number | null = materials.nextOffset; }
  const material = await app.library.read({id: 'record', format: 'base64'});
  if (material.ok && material.format === 'base64') { const encoded: string = material.data; }
  else if (material.ok) { const text: string = material.content; }
  await app.conversations.list({archived: true});
  const history = await app.conversations.messages({id: 'conversation', segmentId: 'segment', after: 0});
  if (history.ok) {
    if (history.requiresSegment) { const segments: SoduWorkApp.ConversationSegment[] = history.segments; }
    else if (history.format === 'events') { const next: number | null = history.nextAfter; }
    else { const next: number | null = history.nextOffset; }
  }
  const directory = await app.directory.list();
  if (directory.ok) { const complete: boolean = !directory.truncated; }
  const mention = await app.chat.mention({recipientUserId: 'colleague', text: 'Review this', requestId});
  if (mention.ok) { const state: 'review' | 'select' = mention.state; }
  const sent = await app.chat.send({text: 'Process the record', attachmentIds: [], requestId});
  if (sent.ok) { const accepted: true = sent.accepted; }
  else if (sent.uncertain) { const reason: string = sent.reason; }
  await app.chat.insertText({text: 'Draft', append: true});
  await app.chat.expand();
  await app.chat.collapse();
  const settings = await app.settings.get();
  if (settings.ok) {
    await app.settings.update({values: {theme: 'dark', filters: ['new'], config: {count: 1}}, expectedRevision: settings.revision});
  }
  await app.settings.get({keys: ['credential'], includeSecrets: true});
  await app.settings.get({includeSecrets: false});
  await app.settings.update({remove: ['theme'], secretKeys: ['credential']});
  const schedule = await app.automation.create({text: 'Daily briefing at 09:00', context: {spaceId: 'space', characterName: 'Reporter'}});
  if (schedule.ok) {
    const state: 'created' = schedule.state;
    const id: string = schedule.schedule.id;
    const execution: string = schedule.executionState;
  } else if (schedule.uncertain) { const reason: string = schedule.reason; }
  const result = await app.ai.generate({input: 'Notes', instructions: 'Summarize', maxOutputTokens: 128});
  await app.ai.generate({input: 'Notes', instructions: 'Summarize', maxOutputTokens: null, model: null});
  if (result.ok) { const finish: 'stop' | 'length' = result.finishReason; }
  const apps = await app.data.apps();
  if (apps.ok) { const unavailable: boolean = apps.remoteUnavailable; }
  const row = await app.data.get({collection: 'notes', id: 'note', appId: 'local:other'});
  if (row.ok) { const revision: number = row.revision; }
  await app.data.list({collection: 'notes', after: ''});
  await app.data.list({collection: 'notes', after: null, filter: {status: 'open'}});
  const batch = await app.data.batch({collection: 'notes', operations: [
    {id: 'note', value: {title: 'Draft', children: []}, expectedRevision: 0},
    {id: 'old', delete: true, expectedRevision: 1}
  ]});
  if (batch.ok) for (const item of batch.items) {
    if (item.deleted) { const revision: number = item.revision; }
    else { const value: SoduWorkApp.JsonObject = item.value; }
  }
  const stored = await app.data.assetPut({name: 'icon.png', type: 'image/png', data: new Uint8Array([1])});
  if (stored.ok) {
    const asset = await app.data.assetGet({id: stored.asset.id});
    if (asset.ok && asset.asset !== null) { const bytes: Uint8Array = asset.data; }
  }
  await app.mcp.connect({server: 'declared-service', url: 'https://business.example/mcp', credentialKey: 'credential', context: {recordId: 'record'}});
  // Existing token-mode calls remain type-compatible; no new authorization is granted.
  await app.mcp.connect({server: 'legacy-service', url: 'https://business.example/mcp', token: 'service-session'});
  const picked = await app.attachments.pick();
  if (picked.ok) await app.attachments.check(picked.items.map(item => item.id));
  const imported = await app.attachments.importFile(file, {signal, onProgress(loaded, total) {
    const bytes: number = loaded; const length: number = total;
  }});
  const attachmentId: string = imported.id;
  await app.attachments.release([attachmentId]);
  const selected = await app.files.pickLocal();
  if (selected.ok) for (const item of selected.items) await app.files.copyLocal({projectId: 'project', sourceId: item.sourceId});
  const saved = await app.files.importFile(blob, {projectId: 'project', name: 'image.png', signal, onProgress(progress) {
    const bytes: number = progress.loaded; const length: number = progress.total;
  }});
  if (saved.ok) await app.files.getUrl({projectId: 'project', id: saved.file.id});
  const raw = await app.request('files.begin', {projectId: 'project', name: 'image.png', type: 'image/png', size: 1});
  if (raw.ok) {
    await app.request('files.append', {id: raw.id, offset: 0, data: [1]});
    await app.request('files.finish', {id: raw.id});
    await app.request('files.cancel', {id: raw.id});
  }
  await app.request('context.get');
  await app.request('data.apps', {});
  await app.request('composer.send', {text: 'Raw send', requestId});
  await app.request('ai.generate', {input: 'Input', instructions: 'Skill', requestId});
  const off = app.events.onRefresh(event => { const state: 'settled' = event.state; });
  off();
  app.events.onTurnSettled(() => {});
  app.events.onDataChanged(event => {
    if (event.topic === 'content') {
      const spaceId: string | undefined = event.spaceId;
      const topicId: string | undefined = event.topicId;
    }
  });
}
`;

for (const [name, suffix] of [['browser script', ''], ['ES module', '\nexport {};']]) {
  test(`existing SDK calls compile strictly in a ${name}, including old optional fields`, () => {
    const result = compile(validConsumer + suffix);
    assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
  });
}

test('compiler consumers with Windows separators resolve the same virtual source', () => {
  const result = compile('const app: SoduWorkApp.SDK = window.soduWorkApp;', undefined,
    path.win32.join('C:\\sdk-contract', 'consumer.ts'));
  assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
  assert.ok(result.program.getSourceFile(result.consumer), 'consumer diagnostics and source lookup use the compiler filename');
});

function checkDocumentationExamples(markdown, folder) {
  const examples = [...markdown.matchAll(/```ts\r?\n([\s\S]*?)```/g)];
  assert.ok(examples.length, 'TypeScript setup must have a usable example');
  for (const example of examples) {
    const result = compile(example[1], path.join(folder, 'soduwork-app.d.ts'), path.join(folder, 'documentation-example.ts'));
    assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
  }
}

for (const [language, file] of [['English', 'README.md'], ['Chinese', 'README.zh-CN.md']]) {
  test(`${language} SDK documentation examples compile in the documented browser layout`, () => {
    const folder = path.resolve(__dirname, '../sdk');
    checkDocumentationExamples(fs.readFileSync(path.join(folder, file), 'utf8'), folder);
  });
}

test('both SDK documentation examples compile after a CRLF checkout', () => {
  const folder = path.resolve(__dirname, '../sdk');
  for (const file of ['README.md', 'README.zh-CN.md']) {
    const markdown = fs.readFileSync(path.join(folder, file), 'utf8').replace(/\r?\n/g, '\r\n');
    checkDocumentationExamples(markdown, folder);
  }
});

const invalidCalls = [
  ['unknown SDK helper', `soduWorkApp.connect();`],
  ['native-only request', `soduWorkApp.request('conversation.open', {title: 'New'});`],
  ['unpublished automation management', `soduWorkApp.automation.pause({id: 'schedule'});`],
  ['arbitrary event subscription', `soduWorkApp.events.onMessage(() => {});`],
  ['non-string message', `soduWorkApp.chat.send({text: 1});`],
  ['raw send without request ID', `soduWorkApp.request('composer.send', {text: 'Send'});`],
  ['raw AI call without request ID', `soduWorkApp.request('ai.generate', {input: 'Input', instructions: 'Skill'});`],
  ['wrong raw request parameters', `soduWorkApp.request('files.getUrl', {collection: 'notes', id: 'record'});`],
  ['missing persistent project', `soduWorkApp.files.importFile(new Blob());`],
  ['raw disk path', `soduWorkApp.files.copyLocal({projectId: 'p', sourceId: 'source', path: '/arbitrary'});`],
  ['wrong attachment byte format', `soduWorkApp.request('attachments.append', {id: 'attachment', offset: 0, data: [1]});`],
  ['attachment progress treated as object', `soduWorkApp.attachments.importFile(new Blob(), {onProgress(progress) { progress.loaded; }});`],
  ['file progress treated as numbers', `soduWorkApp.files.importFile(new Blob(), {projectId: 'p', onProgress(loaded: number, total: number) {}});`],
  ['attachment import treated as receipt', `async function read() { const row = await soduWorkApp.attachments.importFile(new Blob()); row.item.id; }`],
  ['user incorrectly read from window context', `async function read() { const row = await soduWorkApp.context.get(); if (row.ok) row.user.id; }`],
  ['failure receipt treated as success', `async function read() { const row = await soduWorkApp.chat.send({text: 'Send'}); const accepted: true = row.accepted; }`],
  ['message acceptance treated as completion', `async function read() { const row = await soduWorkApp.chat.send({text: 'Send'}); if (row.ok) { const done: 'completed' = row.state; } }`],
  ['refresh treated as business success', `soduWorkApp.events.onRefresh(event => { const state: 'completed' = event.state; });`],
  ['missing explicit secret keys', `soduWorkApp.settings.get({includeSecrets: true});`],
  ['settings containing a function', `soduWorkApp.settings.update({values: {callback: () => {}}});`],
  ['record write without revision', `soduWorkApp.data.batch({collection: 'notes', operations: [{id: 'row', value: {}}]});`],
  ['record value is an array', `soduWorkApp.data.batch({collection: 'notes', operations: [{id: 'row', value: [], expectedRevision: 0}]});`],
  ['record value is not JSON', `soduWorkApp.data.batch({collection: 'notes', operations: [{id: 'row', value: {date: new Date()}, expectedRevision: 0}]});`],
  ['invalid data filter', `soduWorkApp.data.list({collection: 'notes', filter: {status: ['open']}});`],
  ['invalid library storage', `soduWorkApp.library.list({storage: 'cloud'});`],
  ['foreign-account readonly query', `soduWorkApp.notifications.list({account: 'other'});`],
  ['empty history query', `soduWorkApp.conversations.messages({});`],
  ['library binary result read as text', `async function read() { const row = await soduWorkApp.library.read({id: 'file'}); if (row.ok && row.format === 'base64') row.content; }`],
  ['cursor from the wrong history format', `async function read() { const row = await soduWorkApp.conversations.messages({id: 'chat'}); if (row.ok && row.format === 'events') row.nextOffset; }`],
  ['data byte result before checking missing asset', `async function read() { const row = await soduWorkApp.data.assetGet({id: 'asset'}); if (row.ok) { const bytes: Uint8Array = row.data; } }`],
];

for (const [name, source] of invalidCalls) {
  test(`compiler rejects ${name} at the consumer call`, () => {
    const result = compile(source);
    const errors = result.diagnostics.filter(row => row.file?.fileName === result.consumer && row.code !== 2304);
    assert.ok(errors.length, describe(result.diagnostics) || 'invalid call compiled');
  });
}

test('declared browser surface matches the actual exported SDK, without exposing native-only facades', () => {
  const window = {crypto: require('node:crypto').webcrypto, addEventListener() {}};
  window.parent = window;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../sdk/soduwork-app.js'), 'utf8'), {
    window, location: {origin: 'https://app.example'}, document: {referrer: ''}, URL,
  });
  const result = compile('declare const api: SoduWorkApp.SDK;');
  assert.equal(result.diagnostics.length, 0, describe(result.diagnostics));
  const checker = result.program.getTypeChecker();
  const declaration = result.program.getSourceFile(result.consumer).statements[0].declarationList.declarations[0];
  const type = checker.getTypeAtLocation(declaration.name);
  function compare(value, declaredType, prefix) {
    const properties = declaredType.getProperties();
    assert.deepEqual(properties.map(row => row.name).sort(), Object.keys(value).sort(), prefix);
    for (const property of properties) {
      const itemType = checker.getTypeOfSymbolAtLocation(property, declaration);
      if (typeof value[property.name] === 'function') {
        assert.ok(itemType.getCallSignatures().length, `${prefix}.${property.name} must be callable`);
      } else if (value[property.name] && typeof value[property.name] === 'object') {
        compare(value[property.name], itemType, `${prefix}.${property.name}`);
      }
    }
  }
  compare(window.soduWorkApp, type, 'soduWorkApp');
});
