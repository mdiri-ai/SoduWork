'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

function clippedAccountLabels() {
  const failures = [];
  const groups = [
    ['.ca-master .cfg-master-head', 'strong,small,.cfg-state'],
    ['.ca-nav-item', '.cfg-nav-copy b,.cfg-nav-copy small,.cfg-state'],
    ['.ca-detail .cfg-detail-head', '.cfg-detail-title span,.cfg-detail-title h2,.cfg-detail-title p,.cfg-state'],
  ];
  for (const [container, selector] of groups) {
    for (const box of document.querySelectorAll(container)) {
      const area = box.getBoundingClientRect();
      for (const label of box.querySelectorAll(selector)) {
        const range = document.createRange();
        range.selectNodeContents(label);
        const bounds = label.getBoundingClientRect();
        if (Array.from(range.getClientRects()).some(r => r.width &&
          (r.left < Math.max(area.left, bounds.left) - 1 || r.right > Math.min(area.right, bounds.right) + 1 ||
           r.top < area.top - 1 || r.bottom > area.bottom + 1))) failures.push(label.textContent);
      }
    }
  }
  return failures;
}

module.exports = async ({openPreferences, js, click, until, output, report}) => {
  const win = await openPreferences();
  await js('SoduWorkAPI.myGit=async()=>({git:{},repos:[]});void 0');
  await click('#wsSettingsDialog [data-view="codeacct"]');
  await until('document.querySelectorAll(".ca-nav-item").length===4');
  const checkText = async () => assert.deepEqual(await js('(' + clippedAccountLabels.toString() + ')()'), []);
  async function shot(name) {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  assert.deepEqual(await js('Array.from(document.querySelectorAll(".ca-nav-item b"),e=>e.textContent)'),
    ['提交身份','HTTPS 令牌','SSH 私钥','连通测试']);
  await checkText();
  await shot('code-account-default');

  await click('[data-cf=name]');
  await win.webContents.insertText('示例作者');
  await click('[data-cf=email]');
  await win.webContents.insertText('long-author-display-for-layout@engineering.example.test');
  const grip = await js('(()=>{const r=document.querySelector("#caBody .cfg-list-divider").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  const width = () => js('document.querySelector(".ca-master").offsetWidth');
  const initial = await width();
  assert.equal(initial, 320);
  win.webContents.sendInputEvent({ type:'mouseDown', ...grip, button:'left', clickCount:1 });
  win.webContents.sendInputEvent({ type:'mouseMove', x:grip.x-60, y:grip.y, modifiers:['leftButton'] });
  win.webContents.sendInputEvent({ type:'mouseUp', x:grip.x-60, y:grip.y, button:'left', clickCount:1 });
  await until('Number(localStorage.getItem("soduwork.codeAccountListWidth")) === 260');
  assert.equal(await js('localStorage.getItem("soduwork.modelListWidth")'), null);
  for (const [id, title] of Object.entries({token:'HTTPS 令牌',ssh:'SSH 私钥',test:'连通测试',identity:'提交身份'})) {
    await click('[data-caopen=' + id + ']');
    assert.equal(await js('document.querySelector(".ca-detail h2").textContent'), title);
    assert.equal(await width(), 260);
    await checkText();
  }
  assert.equal(await js('document.querySelector("[data-cf=name]").value'), '示例作者');
  await js('applyFontScale("large")');
  await checkText();
  await shot('code-account-large');
  win.setSize(860, 700);
  await until('getComputedStyle(document.querySelector("#caBody .cfg-list-divider")).display==="none"');
  await click('[data-caopen=token]');
  await checkText();
  win.setSize(560, 550);
  await until('innerWidth < 580');
  await click('[data-caopen=test]');
  await checkText();
  assert.ok(await js('const body=document.querySelector("#caBody");body.scrollWidth <= body.clientWidth+1'));
  assert.ok(await js('document.querySelector("#caTest").getBoundingClientRect().width>0'));
  report.checks.push('Four full navigation labels, section descriptions and status text, drag width and independent preference, preserved author draft, large font, 860 and 560 DIP windows');
};
