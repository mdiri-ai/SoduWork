'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot() {
  let owner = 'owner-a', active = null;
  const calls = { prepared: [], invoked: [], refined: [], notices: [] };
  const classes = new Set();
  const box = { innerHTML: '', classList: { add: n => classes.add(n), remove: n => classes.delete(n) } };
  const input = { focus() {} };
  const mount = { querySelector: selector => selector === '#nchatInput' ? input : null };
  const ctx = {
    _ref: 'conversation-a', _viewEpoch: 1, _sessionOptions: {}, _taskAttachments: [],
    _mount: () => mount, _api: () => ({}),
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    _workCards: { async prepare(command, options) { calls.prepared.push({command, options}); return options; } },
  };
  const g = {
    console, setTimeout: () => 0,
    document: { getElementById: id => id === 'nchatTaskSuggest' ? box : id === 'nchatInput' ? input : null },
    SoduWorkAPI: { taskStorageKey: () => owner },
    composeDraftBridge: () => ({}),
    WorkEntrySheet: { active: () => active, refine: async (...args) => { calls.refined.push(args); return true; } },
    PluginUIHost: { invoke: async (action, options) => { calls.invoked.push({action, options}); } },
    petSay: value => calls.notices.push(value),
  };
  g.window = g;
  vm.createContext(g);
  for (const file of ['panels-chat-work-actions.js', 'chat-work-intent.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../components/panels', file), 'utf8'), g);
  }
  g.ChatWorkActions.showPending = () => null;
  const intent = g.ChatWorkIntent.create(ctx);
  Object.assign(ctx, intent);
  const button = { dataset: { proposalAct: 'review' }, disabled: false, isConnected: true };
  const event = { target: { closest: selector => selector === '[data-proposal-act]' ? button : null } };
  const propose = (proposal, id = 'tool-one') => intent._maybeProposal({ tools: [
    { id, state: 'done', result: JSON.stringify({ proposal }) },
  ] });
  return { ctx, g, intent, box, button, calls, propose, click: () => intent._proposalAction(event),
    active: value => { active = value; }, owner: value => { owner = value; } };
}

const proposal = { title: '修复检索问题', note: '保留完整背景', kind: 'bug',
  checklist: ['结果正确', '保留原记录'], priority: 'high', assigneeKind: 'me', repoId: 'repo-one' };

test('a completed task proposal exposes an actionable, escaped confirmation entry', () => {
  const h = boot();
  h.propose({...proposal, title: '<img src=x onerror=alert(1)>'});
  assert.match(h.box.innerHTML, /data-proposal-act="review"/);
  assert.match(h.box.innerHTML, /确认需求与完成标准/);
  assert.ok(!h.box.innerHTML.includes('<img'));
  assert.equal(h.calls.invoked.length, 0, 'receiving a proposal must not open or submit a form automatically');
});

test('review passes the existing structured proposal to the real work-form router without refining another draft', async () => {
  const h = boot();
  h.active({actionId: 'work.requirement.create'});
  h.propose(proposal);
  await h.click();
  assert.equal(h.calls.invoked.length, 1);
  assert.equal(h.calls.invoked[0].action, 'work.requirement.create');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.invoked[0].options.proposal)), proposal);
  assert.equal(h.calls.refined.length, 0, 'review must not send the title as a refinement of an unrelated form');
  assert.equal(h.ctx._pendingProposal, null);
});

test('repeated review clicks while preparing the form open only one confirmation card', async () => {
  const h = boot();
  let release;
  h.ctx._workCards.prepare = (_command, options) => new Promise(resolve => { release = () => resolve(options); });
  h.propose(proposal);
  const pending = h.click();
  await h.click();
  assert.equal(h.button.disabled, true);
  release();
  await pending;
  assert.equal(h.calls.invoked.length, 1);
});

test('a failed form opening retains the proposal and permits retry', async () => {
  const h = boot();
  h.g.PluginUIHost.invoke = async () => { throw Error('isolated form failure'); };
  h.propose(proposal);
  await h.click();
  assert.equal(h.ctx._pendingProposal.p.title, proposal.title);
  assert.equal(h.ctx._proposalMuted, undefined);
  assert.match(h.box.innerHTML, /data-proposal-act="review"/);
  h.g.PluginUIHost.invoke = async (action, options) => { h.calls.invoked.push({action, options}); };
  await h.click();
  assert.equal(h.calls.invoked.length, 1);
});

test('a late failure cannot restore a proposal into another conversation or account', async () => {
  const h = boot();
  let reject;
  h.ctx._workCards.prepare = () => new Promise((_, no) => { reject = no; });
  h.propose(proposal);
  const pending = h.click();
  h.ctx._ref = 'conversation-b'; h.ctx._viewEpoch++; h.owner('owner-b');
  h.ctx._pendingProposal = {key: 'new', p: {title: '另一账号的草稿'}};
  reject(Error('late failure'));
  await pending;
  assert.equal(h.ctx._pendingProposal.key, 'new');
  assert.equal(h.calls.invoked.length, 0);
});

test('reviewing a proposal keeps future proposals available in the same conversation', async () => {
  const h = boot();
  h.propose(proposal, 'first');
  await h.click();
  h.propose({...proposal, title: 'Another task'}, 'second');
  assert.equal(h.ctx._pendingProposal?.key, 'second');
  await h.click();
  assert.equal(h.calls.invoked.length, 2);
});

test('replaying consolidated snapshots cannot surface an older proposal after confirmation', async () => {
  const h = boot();
  const history = ['older', 'latest'].map(id => ({id, state: 'done', result: JSON.stringify({proposal: {title: id}})}));
  h.intent._maybeProposal({tools: history});
  assert.equal(h.ctx._pendingProposal.key, 'latest');
  await h.click();
  h.intent._maybeProposal({tools: history});
  assert.equal(h.ctx._pendingProposal, null);
  h.intent._maybeProposal({tools: history.slice(0, 1)});
  assert.equal(h.ctx._pendingProposal, null);
});

test('a delayed form opening leaves a newer suggestion visible', async () => {
  const h = boot();
  let release;
  h.ctx._workCards.prepare = (_command, options) => new Promise(resolve => { release = () => resolve(options); });
  h.propose(proposal, 'first');
  const pending = h.click();
  h.propose({...proposal, title: 'Another task'}, 'second');
  release();
  await pending;
  assert.equal(h.ctx._pendingProposal.key, 'second');
});

test('dismiss still mutes the suggestion without opening a form', async () => {
  const h = boot();
  h.propose(proposal); h.button.dataset.proposalAct = 'dismiss';
  await h.click();
  assert.equal(h.ctx._pendingProposal, null);
  assert.equal(h.ctx._proposalMuted, true);
  assert.equal(h.calls.invoked.length, 0);
});
