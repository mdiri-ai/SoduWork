'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const providers = [
  ['shared', '共享模型服务', ''],
  ['openai', 'OpenAI 兼容服务', ''],
  ['volcengine', '字节跳动 · 火山引擎方舟', 'ark.cn-beijing.volces.com'],
  ['deepseek', 'DeepSeek', 'api.deepseek.com'],
  ['aliyun', '阿里云百炼（通义）', 'dashscope.aliyuncs.com'],
  ['zhipu', '智谱 GLM', 'open.bigmodel.cn'],
  ['personal', '个人开发测试服务 · 团队共享的 OpenAI 兼容模型与多模态实验环境', 'long-catalog-host-without-spaces.model-services.example.test'],
].map(([id, name, host]) => ({
  id, name, builtin: id !== 'personal', personal: id === 'personal',
  baseUrl: host ? 'https://' + host + '/v1' : '',
  modelNames: id === 'aliyun' ? ['qwen-plus', 'qwen3-coder-plus'] : [],
}));
const catalog = { providers, myModels: [], usable: providers.find(p => p.id === 'aliyun').modelNames };

function findClippedText() {
  const failures = [];
  function check(el, box) {
    const area = box.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    for (const r of range.getClientRects()) {
      if (r.width && (r.left < area.left - 1 || r.right > area.right + 1 ||
          r.top < area.top - 1 || r.bottom > area.bottom + 1)) failures.push(el.textContent);
    }
    if (getComputedStyle(el).textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) failures.push(el.textContent);
  }
  for (const row of document.querySelectorAll('.md-nav-item'))
    for (const el of row.querySelectorAll('.cfg-nav-copy b,.cfg-nav-copy small,.cfg-nav-meta em')) check(el, row);
  for (const el of document.querySelectorAll('.cfg-detail-title h2,.cfg-detail-title p,.cfg-detail-head>.cfg-state'))
    check(el, el.closest('.cfg-detail-head'));
  return failures;
}
module.exports = async ({ workspace, openPreferences, close, js, click, until, output, report }) => {
  let win;
  const grip = '.cfg-list-divider';
  const width = () => js('document.querySelector(".md-master").offsetWidth');
  const checkText = async () => assert.deepEqual(await js('(' + findClippedText.toString() + ')()'), []);
  const gripCenter = () => js('(()=>{const r=document.querySelector(".cfg-list-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  const input = event => win.webContents.sendInputEvent(event);
  async function openModels() {
    win = await openPreferences();
    await js('SoduWorkAPI.myModels=async()=>(' + JSON.stringify(catalog) + ');void 0');
    await click('#wsSettingsDialog [data-view="models"]');
    await until('document.querySelectorAll(".md-nav-item").length === ' + providers.length);
  }
  async function shot(name) {
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await openModels();
  const { width: w, height: h } = win.getBounds();
  const parent = workspace.getBounds();
  // Win32 can round the native frame outwards at fractional display scaling.
  assert.ok(Math.abs(w - Math.min(1200, parent.width * 0.78)) <= 4 &&
    Math.abs(h - Math.min(820, parent.height * 0.84)) <= 4, JSON.stringify({parent, w, h}));
  await click('[data-mdselect="aliyun"]');
  await checkText();
  assert.match(await js('document.querySelector(".cfg-detail-title").innerText'), /阿里云百炼（通义）[\s\S]*dashscope\.aliyuncs\.com[\s\S]*凭据由管理员维护/);
  assert.equal(await js('document.querySelector(".md-row-b").firstElementChild.querySelectorAll("[data-md-model]").length'), 2);
  assert.ok(await js('document.querySelector(".md-model-name").getBoundingClientRect().top < document.querySelector(".cfg-detail-scroll").getBoundingClientRect().bottom'));
  assert.ok(await js('document.querySelector(".md-field input").readOnly'));
  await shot('models-default');
  report.checks.push('Avatar window size, full text on both sides, first-screen model catalog and read-only fields');

  const start = await width();
  const point = await gripCenter();
  const to = { ...point, x: point.x + 48 };
  input({ type:'mouseDown', ...point, button:'left', clickCount:1 });
  input({ type:'mouseMove', ...to, modifiers:['leftButton'] });
  input({ type:'mouseUp', ...to, button:'left', clickCount:1 });
  await until('Number(localStorage.getItem("soduwork.modelListWidth")) > ' + start, 'drag saved');
  const dragged = await width();
  assert.ok(dragged > start && dragged <= start + 49);
  assert.ok(await js('document.querySelector(".cfg-detail").clientWidth >= 420'));
  await checkText();
  await shot('models-dragged');
  await close();
  await openModels();
  assert.equal(await width(), dragged, 'Remember width after closing the native window');
  await click(grip);
  input({ type:'keyDown', keyCode:'Home' }); input({ type:'keyUp', keyCode:'Home' });
  await until('document.querySelector(".md-master").offsetWidth === 240');
  await checkText();
  const mid = await gripCenter();
  for (const count of [1, 2]) for (const type of ['mouseDown', 'mouseUp'])
    input({type, ...mid, button:'left', clickCount:count});
  await until('document.querySelector(".md-master").offsetWidth === 320');
  report.checks.push('Pointer drag, minimum details width, persistence on reopen, keyboard resize and double-click reset');

  await click('#mdQ');
  await win.webContents.insertText('qwen3-coder');
  await until('document.querySelectorAll(".md-nav-item").length===1');
  await click('[data-mdselect="aliyun"]');
  assert.equal(await js('document.querySelector(".cfg-detail-title h2").textContent'), '阿里云百炼（通义）');
  await js('const q=document.querySelector("#mdQ");q.value="";q.dispatchEvent(new Event("input",{bubbles:true}));void 0');
  await click('[data-mdselect="personal"]');
  assert.equal(await js('document.querySelector("[data-pname]").readOnly'), false);
  assert.equal(await js('document.querySelector(".md-row-b").firstElementChild.querySelector("b").textContent'), '连接设置');
  await click('#wsSettingsDialog [data-view="settings"]');
  await click('#fontSeg [data-font="large"]');
  await click('#wsSettingsDialog [data-view="models"]');
  await until('document.querySelector("[data-mdselect=personal]")');
  await click('[data-mdselect="personal"]');
  assert.equal(await js('document.documentElement.style.getPropertyValue("--font-scale")'), '1.15');
  await checkText();
  assert.ok(await js('document.querySelector(".cfg-detail-title h2").getBoundingClientRect().height > parseFloat(getComputedStyle(document.querySelector(".cfg-detail-title h2")).lineHeight)*1.9'));
  await shot('models-large-text');
  await click('#wsSettingsDialog [data-view="settings"]');
  await click('#fontSeg [data-font="medium"]');
  await click('#wsSettingsDialog [data-view="models"]');
  await until('document.querySelector("[data-mdselect=aliyun]")');
  await click('[data-mdselect="aliyun"]');
  win.setSize(860, 700);
  await until('getComputedStyle(document.querySelector(".cfg-list-divider")).display==="none"');
  await checkText();
  const gap = await js('document.querySelector(".cfg-detail").getBoundingClientRect().top-document.querySelector(".md-master").getBoundingClientRect().bottom');
  assert.ok(Math.abs(gap) <= 1, 'Stacked panes should meet, gap ' + gap);
  await shot('models-narrow');
  await click('[data-mdselect="zhipu"]');
  assert.equal(await js('document.querySelector(".cfg-detail-title h2").textContent'), '智谱 GLM');
  win.setSize(560, 560);
  await until('innerWidth < 580');
  await click('[data-mdselect="personal"]');
  await checkText();
  assert.ok(await js('document.querySelector("#mdBody").scrollWidth <= document.querySelector("#mdBody").clientWidth + 1'));
  report.checks.push('Search by model name, editable and read-only providers, large font, narrow and minimum window widths');
};
