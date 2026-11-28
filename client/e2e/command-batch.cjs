'use strict';

const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'soduwork-command-batch-')));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'fixtures/long-conversation.html'));
    const result = await win.webContents.executeJavaScript(`(() => {
      ctx._messageWindowSize = 80;
      ctx._snap = {
        status: 'streaming',
        messages: [
          { role: 'user', text: '连续执行三条命令', blocks: [] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
          { role: 'assistant', blocks: [{ kind: 'toolcall', text: '' }] },
        ],
        tools: [
          { id: 'command-1', after: 1, name: 'bash', args: { command: 'npm run build' }, state: 'done', result: 'ok' },
          { id: 'command-2', after: 2, name: 'bash', args: { command: 'npm test' }, state: 'done', result: 'ok' },
          { id: 'command-3', after: 3, name: 'bash', args: { command: 'npm run lint' }, state: 'running', partial: '' },
        ],
      };
      draw();
      const commands = {
        batches: document.querySelectorAll('.ntool-batch').length,
        rows: document.querySelectorAll('.ntool-batch .ntool').length,
        running: document.querySelectorAll('.ntool-batch.running').length,
        count: document.querySelector('.ntool-batch-count').textContent,
        title: document.querySelector('.ntool-batch-title').textContent,
        actions: document.querySelectorAll('.ntool-batch button, .ntool-batch [data-command-record]').length,
      };
      ctx._snap.tools[2] = { ...ctx._snap.tools[2], state: 'error', isError: true, result: 'failed' };
      draw();
      const failed = document.querySelector('.ntool-batch.error');
      const failure = { title: failed.querySelector('.ntool-batch-title').textContent,
        detail: failed.querySelector('.ntool-batch-detail').textContent,
        count: failed.querySelector('.ntool-batch-count').textContent };
      ctx._snap.tools[1].after = 1;
      ctx._snap.tools[2] = { id: 'read-3', after: 1, name: 'read', state: 'done',
        args: { path: 'readme.txt' }, result: 'text' };
      draw();
      const trigger = document.querySelector('[data-tool-group]');
      const batch = trigger.closest('.ntool-batch');
      const mixed = { rows: batch.querySelectorAll('.ntool').length,
        initiallyExpanded: trigger.getAttribute('aria-expanded') };
      ChatTools.toggleGroup(trigger, ctx._openToolGroup);
      mixed.afterOpening = trigger.getAttribute('aria-expanded');
      ChatTools.toggleGroup(trigger, ctx._openToolGroup);
      mixed.afterClosing = trigger.getAttribute('aria-expanded');
      return { commands, failure, mixed };
    })()`);
    assert.deepEqual(result.commands, { batches: 1, rows: 0, running: 1, count: '3 项',
      title: '正在运行命令', actions: 0 });
    assert.deepEqual(result.failure, { title: '命令执行有异常', detail: '1 项异常', count: '3 项' });
    assert.deepEqual(result.mixed, { rows: 3, initiallyExpanded: 'false', afterOpening: 'true', afterClosing: 'false' });
    console.log(JSON.stringify({ ok: true, result }));
  } finally {
    win.destroy();
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });
