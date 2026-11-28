'use strict';
// Exercise the actual proposal button, editable form and explicit save with isolated APIs.
const path = require('node:path');
const client = path.resolve(__dirname, '..');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawn(electron, [__filename], {env, windowsHide:true, stdio:'inherit'});
  const timer = setTimeout(() => child.kill(), 60000);
  child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
} else {
  const {app, BrowserWindow} = electron;
  const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
  const out = path.resolve(process.argv[2] || path.join(client, '../outputs/task-proposal'));
  fs.mkdirSync(out, {recursive:true});
  const temporary = fs.mkdtempSync(path.join(out, 'runtime-'));
  app.setPath('userData', path.join(temporary, 'profile'));
  const report = {ok:false, realHub:false, realModel:false};
  let win;
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(code) {
    for (let i=0; i<150; i++) { if (await js(code)) return; await wait(20); }
    throw Error('Timed out: ' + code);
  }
  async function click(selector) {
    await js('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center"})');
    await wait(150);
    const point = await js('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + '),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,...point,button:'left',clickCount:1});
  }
  app.whenReady().then(async () => {
    const desk = fs.readFileSync(path.join(client,'desk.html'),'utf8');
    const styles = [...desk.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)]
      .map(m => fs.readFileSync(path.join(client,m[1]),'utf8')).join('\n');
    const fixture = path.join(temporary,'fixture.html');
    fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><style>'+styles+'</style><main class="nchat-draft"><div class="nchat-task-suggest" id="nchatTaskSuggest"></div></main><textarea id="nchatInput"></textarea>');
    win = new BrowserWindow({show:false,width:1200,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(_request,cb)=>cb({cancel:true}));
    await win.loadFile(fixture);
    await js(`window.calls=[];window.tasks=[];window.toasts=[];window.petSay=t=>toasts.push(t);window.uid=()=> 'issue655-isolated-task-'+(tasks.length+1);
      window.save=()=>calls.push({kind:'save-local'});window.Store={persistTask:async id=>{calls.push({kind:'persist',id});return true},dropTask(){}};
      window.Requirements={dateTimestamp:()=>null};
      window.SoduWorkAPI={taskStorageKey:()=> 'issue655-owner',listTeammates:async()=>({mates:[]}),
        parseTaskText:async()=>{calls.push({kind:'parse'});throw Error('Structured proposal must not be parsed again')}};void 0;`);
    for (const name of ['task-priority','task-execution-client','plugin-ui-host','requirement-routing','panels-compose-submit','panels-compose-draft','work-entry-sheet','panels-chat-work-actions','chat-work-intent'])
      await js(fs.readFileSync(path.join(client,'components/panels',name+'.js'),'utf8')+'\nvoid 0;');
    await js(fs.readFileSync(path.join(client,'components/requirements/requirement-fields.js'),'utf8')+'\nvoid 0;');
    const proposal = {title:'验证对话需求录入',note:'原始需求说明',kind:'bug',priority:'high',checklist:['验收标准甲','验收标准乙'],assigneeKind:'me'};
    await js(`window.proposalCtx={_ref:'isolated-conversation',_viewEpoch:1,_sessionOptions:{},_taskAttachments:[],_mount:()=>document.body,
      _bindCollaborationTask:(id,title)=>calls.push({kind:'bind',id,title}),
      esc:v=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')};
      Object.assign(proposalCtx,ChatWorkIntent.create(proposalCtx));
      document.getElementById('nchatTaskSuggest').addEventListener('click',e=>{void proposalCtx._proposalAction(e)});
      window.proposalTools=[{id:'old-proposal',state:'done',result:JSON.stringify({proposal:{title:'Earlier suggestion'}})},
        {id:'proposal-tool',state:'done',result:${JSON.stringify(JSON.stringify({proposal}))}}];
      proposalCtx._maybeProposal({tools:proposalTools});void 0;`);
    report.before = await js(`({button:document.querySelector('[data-proposal-act="review"]')?.textContent,tasks:tasks.length})`);
    assert.equal(report.before.button,'确认需求与完成标准'); assert.equal(report.before.tasks,0);
    await click('[data-proposal-act="review"]');
    await until('Boolean(document.querySelector("#cpCreate"))');
    report.draft = await js(`({title:document.querySelector('#cpTitle').value,note:document.querySelector('#cpNote').value,kind:document.querySelector('#cpKind').value,tasks:tasks.length})`);
    assert.equal(report.draft.title,proposal.title); assert.equal(report.draft.note,proposal.note);
    assert.equal(report.draft.kind,'bug'); assert.equal(report.draft.tasks,0);
    await click('#cpCreate'); await until('Boolean(document.querySelector(".cp-ok"))');
    report.after = await js('({tasks:JSON.parse(JSON.stringify(tasks)),calls:JSON.parse(JSON.stringify(calls)),toasts:toasts.slice()})');
    assert.equal(report.after.tasks.length,1); assert.equal(report.after.tasks[0].title,proposal.title);
    assert.equal(report.after.tasks[0].kind,'bug');
    assert.equal(report.after.tasks[0].note,proposal.note);
    assert.deepEqual(report.after.tasks[0].acceptanceCriteria,proposal.checklist);
    assert.equal(report.after.calls.filter(x=>x.kind==='persist').length,1);
    assert.equal(report.after.calls.filter(x=>x.kind==='parse').length,0);
    await js("WorkEntrySheet.close(); proposalCtx._maybeProposal({tools:proposalTools});void 0;");
    assert.equal(await js("Boolean(document.querySelector('[data-proposal-act=review]'))"), false);
    const next = {...proposal, title:'验证第二条独立需求'};
    await js(`proposalTools.push({id:'second-proposal',state:'done',result:${JSON.stringify(JSON.stringify({proposal:next}))}});
      proposalCtx._maybeProposal({tools:proposalTools});void 0;`);
    await click('[data-proposal-act="review"]');
    await until('Boolean(document.querySelector("#cpCreate"))');
    assert.equal(await js("document.querySelector('#cpTitle').value"), next.title);
    assert.equal(await js('tasks.length'), 1);
    await click('#cpCreate'); await until('Boolean(document.querySelector(".cp-ok"))');
    report.second = await js("({titles:tasks.map(t=>t.title),saved:calls.filter(x=>x.kind==='persist').map(x=>x.id)})");
    assert.deepEqual(report.second.titles.sort(), [proposal.title,next.title].sort());
    assert.equal(new Set(report.second.saved).size, 2);
    report.ok=true;
  }).catch(async error => {
    report.error=String(error.stack||error);
    if (win) report.debug=await js('({toasts:window.toasts,body:document.body.innerText,pending:Boolean(window.proposalCtx?._pendingProposal)})').catch(()=>null);
  }).finally(() => {
    fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2)); win?.destroy(); app.exit(report.ok?0:1);
  });
}
