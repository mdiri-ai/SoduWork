'use strict';

// Production renderer and CSS, isolated Electron profile, synthetic models only.
const electron = require('electron');
if (typeof electron === 'string') {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-model-scroll-'));
  const env = { ...process.env };
  env.SODUWORK_SCROLL_TEST_PROFILE = profile;
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[key];
  const child = require('node:child_process').spawn(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  const timer = setTimeout(() => child.kill(), 90000);
  child.on('exit', code => {
    clearTimeout(timer); process.exitCode = code ?? 1;
    fs.rmSync(profile, {recursive:true,force:true,maxRetries:4,retryDelay:100});
  });
} else {
  const { app, BrowserWindow } = electron;
  const path = require('node:path');
  const assert = require('node:assert/strict');
  app.setPath('userData', process.env.SODUWORK_SCROLL_TEST_PROFILE);
  app.disableHardwareAcceleration();
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await delay(30); }
    throw Error('Timeout: ' + code);
  }
  async function click(selector) {
    await js(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
    await delay(30);
    const point = await js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    for (const type of ['mouseDown', 'mouseUp']) win.webContents.sendInputEvent({type, ...point, button:'left', clickCount:1});
    await delay(40);
  }
  const position = () => js(`({left:document.querySelector('.cfg-master-scroll').scrollTop,
    right:document.querySelector('.cfg-detail-scroll').scrollTop,
    max:document.querySelector('.cfg-detail-scroll').scrollHeight-document.querySelector('.cfg-detail-scroll').clientHeight})`);
  async function stable() {
    assert.equal(await js(`leftNode===document.querySelector('.cfg-master-scroll')&&rightNode===document.querySelector('.cfg-detail-scroll')`), true,
      'ordinary operations must retain both scroll containers');
  }
  async function run() {
    win = new BrowserWindow({show:false,width:1500,height:950,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    await win.loadFile(path.join(__dirname, 'fixtures/model-settings.html'));
    await until('_mdLoadState === "ready"');
    await js(`
      fixture.providers.push(...Array.from({length:30},(_,i)=>({id:'extra-'+i,name:'Extra '+i,
        baseUrl:'https://fixture.invalid/v1',keySet:true,modelNames:[]})));
      fixture.myModels=Array.from({length:18},(_,i)=>({providerId:'personal',name:'scroll-model-'+i,label:'Scroll model '+i}));
      _mdData=structuredClone(fixture);_mdMyModels=_mdData.myModels.slice();_mdOpen='personal';_mdRender();
      window.leftNode=document.querySelector('.cfg-master-scroll');window.rightNode=document.querySelector('.cfg-detail-scroll');
      leftNode.scrollTop=150;rightNode.scrollTop=700;
      window.beforeRender={left:leftNode.scrollTop,right:rightNode.scrollTop};_mdRender();
    `);
    await stable();
    let at = await position();
    const before = await js('beforeRender');
    assert.equal(at.left, before.left); assert.equal(at.right, before.right);
    console.log('PASS same-service render retains scroll containers and both positions');

    await click('[data-mdedit="personal|8"]');
    await stable();
    assert.ok((await position()).right > 0, 'editing must not return to the connection form');
    assert.equal(await js('document.activeElement.matches("[data-padd]")'), true);
    await click('[data-mdcancel]'); await stable();
    assert.ok((await position()).right > 0);
    console.log('PASS native edit and cancel preserve the scrolled view');

    await click('[data-md-model] [data-mdcheck]');
    await stable(); assert.ok((await position()).right > 0);
    // Scroll while the async request is pending; completion must use the new view.
    await js(`rightNode.scrollTop=900;window.pendingTop=rightNode.scrollTop`);
    await until('![..._mdChecks.values()].some(check=>check.pending)');
    await stable(); assert.ok(Math.abs((await position()).right - await js('pendingTop')) < 3);
    console.log('PASS capability completion preserves scrolling performed during the request');

    await js(`document.querySelector('[data-mdel="personal|8"]').scrollIntoView({block:'nearest'});
      {const row=[...document.querySelectorAll('[data-md-model]')].find(row=>!row.querySelector('[data-mdel="personal|8"]')&&
        row.getBoundingClientRect().bottom>rightNode.getBoundingClientRect().top&&row.getBoundingClientRect().top<rightNode.getBoundingClientRect().bottom);
      window.anchorKey=row.getAttribute('data-md-model');window.anchorOffset=row.getBoundingClientRect().top-rightNode.getBoundingClientRect().top;}`);
    await click('[data-mdel="personal|8"]');
    await until('!_mdSaveFlight'); await stable();
    assert.equal(await js('_mdMyModels.length'),17);
    assert.ok((await position()).right > 0);
    assert.ok(Math.abs(await js(`[...document.querySelectorAll('[data-md-model]')].find(row=>row.getAttribute('data-md-model')===anchorKey).getBoundingClientRect().top-rightNode.getBoundingClientRect().top-anchorOffset`)) < 3,
      'removing a row must retain the first surviving visible model position');
    console.log('PASS removal and its save/reload retain the current view');

    await js(`rightNode.scrollTop=800;window.personalTop=rightNode.scrollTop;selectService('company')`);
    assert.equal((await position()).right,0);
    await js(`selectService('personal')`);
    assert.ok(Math.abs((await position()).right - await js('personalTop')) < 3);
    await stable();
    console.log('PASS service switching starts new services at top and restores previous service position');

    win.setSize(800,950);
    await until('getComputedStyle(rightNode).overflowY === "visible"');
    await js(`window.outerNode=document.getElementById('mdBody');outerNode.scrollTop=1400;
      window.outerTop=outerNode.scrollTop;_mdRender()`);
    assert.ok(await js('outerTop>0'));
    assert.ok(Math.abs(await js('outerNode.scrollTop-outerTop')) < 3);
    await js(`selectService('company')`);
    assert.equal(await js('outerNode.scrollTop'),0);
    await js(`selectService('personal')`);
    assert.ok(Math.abs(await js('outerNode.scrollTop-outerTop')) < 3);
    console.log('PASS narrow layouts preserve and restore the actual outer scrolling viewport');
    win.setSize(1500,950);
    await until('getComputedStyle(rightNode).overflowY === "auto"');

    await js(`rightNode.scrollTop=rightNode.scrollHeight;_mdMyModels=[];_mdRender()`);
    at = await position(); assert.ok(at.right <= at.max && at.right >= 0); await stable();
    console.log('PASS shrinking content clamps to the remaining scroll range');

    await js(`document.querySelector('#mdAddInline').click()`);
    assert.equal((await position()).right,0);
    console.log('PASS a new service opens at the top');
  }
  app.whenReady().then(run).then(() => { win.destroy(); app.exit(0); }).catch(error => {
    console.error(error); if (win) win.destroy(); app.exit(1);
  });
}
