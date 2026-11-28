// Check rendered edges in the preferences window with the production settings controls.
'use strict';
const assert = require('node:assert/strict');

module.exports = async function checkSettingsGroups({ win, js, click, type, until, shot, report }) {
  const go = async view => {
    await click('#wsSettingsDialog [data-view="' + view + '"]');
    await until('WorkspaceHost.view === ' + JSON.stringify(view));
  };
  const settled = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const resize = async (width, height) => {
    win.setContentSize(width, height);
    await until('Math.abs(innerWidth - ' + width + ') <= 1 && Math.abs(innerHeight - ' + height + ') <= 1');
    await settled();
  };
  const rect = async selector => js(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
  const near = (value, expected, label) => {
    assert.ok(Math.abs(value - expected) <= 1, label + ': expected ' + expected + ', got ' + value);
  };
  const edges = async (outer, inner, inset = 0) => {
    const a = await rect(outer), b = await rect(inner);
    near(b.left - a.left, inset, inner + ' left');
    near(a.right - b.right, inset, inner + ' right');
  };
  const detailHeading = async (panel, section, leading) => {
    const card = await rect(panel + ' ' + section);
    const left = await rect(panel + ' ' + leading), right = await rect(panel + ' .cfg-detail-head > .cfg-state');
    near(left.left - card.left, 8, panel + ' detail heading inset');
    near(card.right - right.right, 8, panel + ' detail status inset');
  };

  await js('fixtureOverrides.syncConfig = () => true; void 0');
  await go('settings');
  for (const size of ['small', 'large', 'medium']) {
    await click('#fontSeg [data-font="' + size + '"]');
    for (const [width, height] of [[560, 440], [960, 700]]) {
      await resize(width, height);
      const groups = await js(`[...document.querySelectorAll('.ws-settings-sidebar .ws-nav-group')].map(group => {
        const label = group.querySelector('.ws-section-label');
        const range = document.createRange(); range.selectNodeContents(label);
        const sidebar = group.closest('nav').getBoundingClientRect();
        return { label: range.getBoundingClientRect().left, bottom: label.getBoundingClientRect().bottom,
          sidebar: [sidebar.left, sidebar.right], rows: [...group.querySelectorAll('button')].map(button => {
            const row = button.getBoundingClientRect(), icon = button.querySelector('svg').getBoundingClientRect();
            const text = button.querySelector('span').getBoundingClientRect();
            return { left:row.left, right:row.right, top:row.top, icon:icon.left, text:text.left,
              singleLine:text.height <= parseFloat(getComputedStyle(button).lineHeight) + 1 };
          }) };
      })`);
      assert.deepEqual(groups.map(group => group.rows.length), [6, 1, 3]);
      const first = groups[0].rows[0];
      for (const group of groups) {
        near(group.label - first.left, 12, 'section heading inset');
        near(group.rows[0].top - group.bottom, 7, 'heading-to-item gap');
        for (const row of group.rows) {
          near(row.left - group.sidebar[0], group.sidebar[1] - row.right, 'navigation outside gutters');
          near(row.icon, group.label, 'navigation icon');
          near(row.text, first.text, 'navigation text');
          assert.ok(row.singleLine, 'navigation label wraps at ' + width + ' / ' + size);
        }
      }
    }
  }
  report.checks.push('Sidebar label, icon and text columns plus equal outside gutters at three font sizes and two window sizes');

  await js(`fixtureData.myModels.providers = [{id:'demo-models', name:'示例模型服务', modelNames:[]}];
    const node = {runnerId:'demo', label:'示例执行机', owned:true, online:true, scope:'current-instance', agents:[{key:'pi',name:'Pi',installed:true}]};
    fixtureData.runners.runners = [node]; fixtureData.localAgentSetup = {machines:[node], modelCount:0}; void 0`);
  await go('account');
  for (const key of ['devices', 'privacy', 'security']) {
    await click('#personalAccountPanel [data-tab="' + key + '"]');
    await edges('.ac-center-tabs', '#account-tab-content');
  }
  await click('[data-email-change]'); await click('.ac-email-change [data-ac-close]');
  await go('agents');
  await click('[data-atoggle="demo~pi"]');
  await until('document.querySelector(".ag-drawer")');
  await click('.ag-drawer [data-adrawer-x]');
  await click('[data-agtab="runners"]');
  await click('#agRefresh');
  await until('document.querySelector("[data-rn-card-toggle=demo]")');
  await click('[data-rn-card-toggle="demo"]');
  await until('document.querySelector(".rn-card.is-expanded")');
  await edges('.rn-route', '.rn-workspace');
  const machine = await rect('.rn-dir-machine');
  near((await rect('.rn-directory > header b')).left - machine.left, 12, 'Runner directory title');
  near(machine.right - (await rect('.rn-directory > header em')).right, 12, 'Runner machine count');
  await until('!document.querySelector("#deskToast.show")');
  await shot('runner-directory');
  await go('cloud');
  await click('.ce-empty [data-ce-add]');
  await until('document.querySelector(".ce-dialog[open]")');
  await edges('.ce-dialog form > header', '.ce-dialog .ce-dialog-body');
  await edges('.ce-dialog form > header', '.ce-dialog footer');
  await click('.ce-dialog footer [data-ce-dismiss]');

  for (const width of [560, 960, 1440]) {
    await resize(width, 700);
    await go('models');
    await click('[data-mdselect="demo-models"]');
    await edges('#mdPanel .cfg-master-search', '#mdPanel .cfg-nav-item');
    await edges('#mdPanel .cfg-nav-group', '#mdPanel .cfg-master-search');
    const model = await rect('#mdPanel .cfg-nav-item');
    near((await rect('#mdPanel .cfg-nav-group header span')).left - model.left, 12, 'model group title');
    near(model.right - (await rect('#mdPanel .cfg-nav-group header em')).right, 12, 'model group count');
    const icon = await rect('#mdPanel .cfg-detail-icon');
    await detailHeading('#mdPanel', '.md-settings-section', icon.width ? '.cfg-detail-icon' : '.cfg-detail-title');
    if (width === 1440) await shot('nested-models');

    await go('codeacct');
    for (const tab of ['token', 'ssh', 'test', 'identity']) {
      const button = '[data-caopen="' + tab + '"]';
      await click(button);
      await until('document.querySelector(' + JSON.stringify(button + '[aria-pressed="true"]') + ')');
      const item = await rect(button);
      near((await rect(button + ' .ca-nav-icon')).left - item.left, 12, 'code account icon');
      near((await rect('#caPanel .cfg-master-head strong')).left - item.left, 12, 'code account heading');
      await edges('#caPanel .cfg-detail-section', '#caPanel .cfg-detail-callout');
      await detailHeading('#caPanel', '.cfg-detail-section', '.cfg-detail-icon');
    }
    if (width === 1440) await shot('nested-code-account');
  }
  await resize(960, 700);
  await go('archive');
  for (const tab of ['projects', 'chats']) {
    await click('[data-archive-tab="' + tab + '"]');
    const frame = await rect('.archive-history-filters');
    near((await rect('.archive-history-tabs')).left - frame.left, 8, 'archive tabs');
    await edges('.archive-history-filters', '[data-archive-tabpanel="' + tab + '"] .archive-history-list');
  }
  await shot('archive-groups');
  await go('usage');
  await until('document.querySelector(".usage-overview")');
  await edges('.usage-overview', '.usage-columns');
  await edges('.usage-overview', '.usage-recent');
  await go('skin');
  const skinTitleLeft = await js(`(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('.skin-section-title').firstChild);
    return range.getBoundingClientRect().left;
  })()`);
  near(skinTitleLeft - (await rect('.skin-grid')).left, 8, 'appearance section title');
  await shot('appearance-groups');
  await go('shortcuts');
  for (const width of [560, 960]) {
    await resize(width, 700);
    const search = await rect('.shortcuts-search'), reset = await rect('[data-shortcut-reset-all]');
    const card = await rect('.shortcut-group');
    near(search.left, card.left, 'shortcut search left');
    near(reset.right, card.right, 'shortcut reset right');
    near(search.top, reset.top, 'shortcut toolbar top');
    near(search.bottom, reset.bottom, 'shortcut toolbar bottom');
  }
  await edges('.shortcut-group', '.shortcut-group-title');
  const shortcutBar = await js(`(() => {
    const style = getComputedStyle(document.querySelector('.shortcut-group-title'));
    return { stripe: style.borderLeftWidth, background: style.backgroundColor };
  })()`);
  assert.equal(shortcutBar.stripe, '3px');
  assert.notEqual(shortcutBar.background, 'rgba(0, 0, 0, 0)');
  await settled();
  await shot('sidebar-and-shortcuts');
  await type('[data-shortcut-search]', '全局搜索');
  await until('document.querySelectorAll("[data-shortcut-row]").length === 1');
  const binding = 'document.querySelector("[data-shortcut-edit]").textContent';
  const original = await js(binding);
  await click('[data-shortcut-edit]'); await click('[data-shortcut-cancel]');
  await click('[data-shortcut-edit]');
  for (const event of ['keyDown','keyUp']) {
    win.webContents.sendInputEvent({type:event, keyCode:'Y', modifiers:['control','alt']});
  }
  await click('[data-shortcut-save]');
  await until(binding + ' !== ' + JSON.stringify(original));
  await click('[data-shortcut-reset-all]');
  await until(binding + ' === ' + JSON.stringify(original));
  await type('[data-shortcut-search]', '');
  report.checks.push('Account tabs, Agent drawer, expanded Runner, setup form, model service, four Git sections, archive tabs and shortcut search/edit/save/reset');
};
