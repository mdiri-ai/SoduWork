const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
test('bundle fingerprints are read-only labels; actual approval attachments stay clickable',()=>{
 const window={SoduWorkAPI:{attachmentUrl:item=>'https://hub.example/attachments/'+item.id}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../components/panels/task-trace-view.js'),'utf8'),{window,SoduWorkAPI:window.SoduWorkAPI});
 const html=window.TaskTraceView.gateHtml({schemaVersion:'soduwork.gate/1.1',subject:{},criteria:[],requirements:[],evidence:[
  {id:'artifact:version:files',kind:'file',title:'Fixed bundle',url:''},
  {id:'8cd318b6-1614-4085-8c4d-81117c26eb92',attachmentId:'8cd318b6-1614-4085-8c4d-81117c26eb92',url:'/api/v1/attachments/8cd318b6-1614-4085-8c4d-81117c26eb92',kind:'file',title:'live-result.txt'}
 ]});
 assert.match(html,/<span>Fixed bundle<\/span>/);assert.doesNotMatch(html,/href="[^\"]*artifact:version/);
 assert.match(html,/<a href="https:\/\/hub.example\/attachments\/8cd318b6[^\"]*"[^>]*>live-result.txt<\/a>/);
 assert.match(html, /data-tfd-evidence-filename="live-result\.txt"/);
});

test('desktop file evidence uses native download and regular links still open externally', async () => {
  const calls = [];
  const window = {
    soduWorkAPI: {
      downloadAttachment: async ({ url, filename }) => {
        calls.push(['download', url, filename]);
        return { ok: true };
      },
      openExternal: async (url) => {
        calls.push(['external', url]);
        return { ok: true };
      },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/panels/task-trace-view.js'), 'utf8'), { window });
  const file = 'https://hub.example/api/v1/attachments/8cd318b6-1614-4085-8c4d-81117c26eb92';
  const url = 'https://example.com/deliverable';
  await window.TaskTraceView.openEvidence({ href: file, dataset: { tfdEvidenceFilename: 'live-result.txt' } });
  await window.TaskTraceView.openEvidence({ href: url, dataset: {} });
  assert.deepEqual(calls, [['download', file, 'live-result.txt'], ['external', url]]);
});
