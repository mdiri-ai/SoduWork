'use strict';

const assert = require('node:assert/strict');

function overview(source, model, tokens, days) {
  const size = source === 'hub' ? 8 : 2;
  const recent = Array.from({length: size}, (_, i) => ({
    id: source + i, title: source + '-work-' + i, model, agent: 'pi',
    sourceType: i % 2 ? 'task' : 'chat', sourceLabel: i % 2 ? 'Issue' : 'Chat',
    taskId: i % 2 ? 'fixture-issue-' + i : '', tokens: tokens / size,
    requests: 1, durationMs: 2000, costKnown: true, currency: 'USD', costMicrousd: 5000,
    quality: 'reported', occurredAt: new Date(Date.UTC(2026, 0, 7, 18 - i, source === 'hub' ? 30 : 0)).toISOString(),
  }));
  return {
    days, summary: {tokens, sessions: size, requests: size, durationMs: 2000 * size, costMicrousd: 5000 * size},
    byAgent: [{agent: 'pi', model, provider: source, tokens, sessions: size}],
    bySource: [{key: 'chat', label: 'Chat', tokens: tokens / 2, sessions: size / 2},
      {key: 'task', label: 'Issue', tokens: tokens / 2, sessions: size / 2}],
    trend: Array.from({length: days}, (_, i) => ({key: '2026-01-' + String(i + 1).padStart(2, '0'),
      tokens: i + 1 === days ? tokens : 0})),
    quality: {reported: size, estimated: 0, reconciled: 0, unknown: 0},
    costQuality: {records: size, unknown: 0, otherCurrency: 0}, recent,
  };
}

module.exports = async function auditUsage({js, click, until, win, delay, shot}) {
  // The audit window is offscreen. Enable normal Chromium focus events for keyboard navigation.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled: true});
  try {
    await checkUsage({js, click, until, win, delay, shot});
  } finally {
    win.webContents.debugger.detach();
  }
};

async function checkUsage({js, click, until, win, delay, shot}) {
  const quota = {enabled: true, totalLimited: true, limit: 18000, used: 8000, remaining: 10000,
    planName: 'Fixture allowance', period: '2026-01', resetsAt: '2026-02-01T00:00:00+08:00', models: []};
  const payload = {days: 7, hub: overview('hub', 'Hub Alpha', 8000, 7),
    local: overview('local', 'Local Beta', 2000, 7), quota};
  await js('fixtureData.myUsage=' + JSON.stringify(payload) + '; void 0');
  await click('#usagePanel [data-days="7"]');
  await until('document.querySelector(".usage-big b")?.title === "10,000 Tokens"');
  const read = selector => js('document.querySelector(' + JSON.stringify(selector) + ')?.innerText');
  const readRecords = () => js('Array.from(document.querySelectorAll("[data-record]"), b => b.textContent)');
  const key = code => {
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({type, keyCode: code});
  };
  async function chooseGroup(value) {
    // Native select dispatches change on keyboard selection.
    await js('document.querySelector("#usageGroup").focus()');
    key(value === 'scene' ? 'End' : 'Home');
    if (value === 'model') key('Down');
    await until('document.querySelector("#usageGroup").value===' + JSON.stringify(value));
  }

  await click('#usageQuotaDetails');
  assert.match(await read('#usageDialog[open]'), /Fixture allowance/);
  assert.match(await read('#usageDialogBody'), /18,000/);
  await click('#usageDialogClose');
  const firstPage = await readRecords();
  assert.equal(firstPage.length, 5);
  await click('#usageNext');
  const secondPage = await readRecords();
  assert.equal(secondPage.length, 5);
  assert.equal(new Set([...firstPage, ...secondPage]).size, 10);
  await click('#usagePrev');
  assert.deepEqual(await readRecords(), firstPage);

  await chooseGroup('model');
  assert.match(await read('.usage-rank-scroll'), /Hub Alpha/);
  assert.match(await read('.usage-rank-scroll'), /Local Beta/);
  await click('[data-source="local"]');
  assert.deepEqual(await readRecords(), ['local-work-0', 'local-work-1']);
  assert.doesNotMatch(await read('.usage-rank-scroll'), /Hub Alpha/);
  assert.equal(await js('document.querySelector(".usage-big b").title'), '10,000 Tokens');
  await click('[data-day="2026-01-06"]');
  assert.equal(await js('document.activeElement.dataset.day'), '2026-01-06');
  key('Right');
  await until('document.querySelector("#usageDayRead").textContent.includes("2026-01-07")');
  assert.match(await read('#usageDayRead'), /2,000/);
  await chooseGroup('scene');
  await click('[data-scene="task"]');
  assert.deepEqual(await readRecords(), ['local-work-1']);
  await click('[data-record="0"]');
  assert.equal(await read('#usageDialogTitle'), 'local-work-1');
  assert.match(await read('#usageDialogBody'), /Local Beta/);
  assert.equal(await js('document.querySelector("#usageDialog [data-task]").dataset.task'), 'fixture-issue-1');
  await click('#usageDialogClose');
  await click('#usageClearScene');
  assert.deepEqual(await readRecords(), ['local-work-0', 'local-work-1']);
  await click('[data-source="hub"]');
  assert.ok((await readRecords()).every(title => title.startsWith('hub-work-')));
  await click('[data-source="all"]');
  await chooseGroup('agent');

  await js('fixtureFailures.add("myUsage");void 0');
  await click('#usageRefresh');
  await until('document.querySelector("#usageRefresh").classList.contains("has-error")');
  assert.deepEqual(await readRecords(), firstPage);
  await js('fixtureFailures.delete("myUsage");void 0');
  await click('#usageRefresh');
  await until('!document.querySelector("#usageRefresh").classList.contains("has-error")');
  await js('document.querySelector("#usageBody").scrollTop = 0');
  await delay(100);
  await shot('usage-populated');
  win.setContentSize(820, 620);
  await delay(100);
  assert.ok(await js('document.querySelector("#usageBody").scrollWidth <= document.querySelector("#usageBody").clientWidth + 1'));
  await shot('usage-populated-narrow');
  win.setContentSize(1440, 1000);
  await delay(100);

  // Unlimited plans and longer rankings must keep the summary and chart aligned.
  const busy = structuredClone(payload);
  busy.quota = { enabled: false, used: 0 };
  const agents = ['Pi', 'OpenCode', 'Kimi Code', 'Codex Harness', 'DeepSeek Harness', 'Qwen Code'];
  for (const source of ['hub', 'local']) {
    const view = busy[source];
    const totals = source === 'hub' ? [310000,205000,79000,68000,38000,20000] : [0,61000,30000,0,0,9000];
    view.summary.tokens = totals.reduce((a,b) => a+b,0);
    view.byAgent = agents.flatMap((agent,i) => totals[i] ? [{agent, model:view.byAgent[0].model, tokens:totals[i], sessions:1}] : []);
    const weights = source === 'hub' ? [10,16,8,24,12,18,12] : [4,22,6,12,18,8,30];
    view.trend.forEach((row,i) => { row.tokens = view.summary.tokens * weights[i]/100; });
  }
  await js('fixtureData.myUsage=' + JSON.stringify(busy) + '; void 0');
  await click('#usageRefresh');
  await until('document.querySelector(".usage-status")?.textContent.includes("不限额")');
  assert.equal(await js('document.querySelector(".usage-quota .usage-track").getBoundingClientRect().height'), 0);
  assert.ok(await js('Array.from(document.querySelectorAll(".usage-analysis article"), el => el.offsetHeight).every((v,_,a) => v === a[0])'));
  assert.ok(await js('((el) => el.scrollHeight > el.clientHeight)(document.querySelector(".usage-rank-scroll"))'));
  await shot('usage-light-overview');
  await js('fixtureData.myUsage=' + JSON.stringify(payload) + '; void 0');

  // The device ledger uses a fixed scene label as the title of private model-check receipts.
  await js(`Object.assign(fixtureData.myUsage.local.recent[0], {
    title:'模型检测', sourceType:'model_check', sourceLabel:'模型检测', model:'本地模型'
  }); delete fixtureData.myUsage.quota.planName; void 0`);
  await click('[data-source="local"]');
  for (const [language, heading, scene, model, limit] of [
    ['en-US', 'Usage ranking', 'Model check', 'Local model', 'Total quota'],
    ['ja-JP', '使用量ランキング', 'モデルの動作確認', 'ローカルモデル', '合計利用枠'],
    ['ko-KR', '사용량 순위', '모델 작동 확인', '로컬 모델', '총 한도'],
  ]) {
    await js('SoduWorkI18n.setLocale(' + JSON.stringify(language) + ', {persist:false,broadcast:false})');
    await click('#usageRefresh');
    await until('document.querySelector(".usage-ranking h3").textContent===' + JSON.stringify(heading));
    assert.equal((await readRecords())[0], scene);
    assert.ok((await read('.usage-records')).includes(model));
    assert.ok((await read('.usage-balance + .usage-track + small')).includes(limit));
  }
  await js('SoduWorkI18n.setLocale("zh-CN", {persist:false,broadcast:false})');

  await js('fixtureFailures.add("myUsage");void 0');
  await click('[data-days="90"]');
  await until('document.querySelector("#usageRetry")');
  assert.deepEqual(await readRecords(), []);
  await js('fixtureFailures.delete("myUsage");void 0');
  await click('[data-days="7"]');
  await until('document.querySelector("[data-record]")');
  await click('[data-record="0"]');
  const scopeCleared = await js(`(() => {
    fixtureOverrides.myUsage = () => new Promise(resolve => window.releaseScopeUsage = resolve);
    window.dispatchEvent(new CustomEvent('soduwork-data-scope-changed'));
    return !document.querySelector('[data-record], #usageDialog[open]') &&
      !document.querySelector('#usagePanel').textContent.includes('hub-work-0');
  })()`);
  assert.equal(scopeCleared, true);
  await js('releaseScopeUsage({hub:null, local:null, quota:null}); delete fixtureOverrides.myUsage; void 0');
  await until('document.querySelector("#usageRetry")');
}
