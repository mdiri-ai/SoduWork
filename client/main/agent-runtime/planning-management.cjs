'use strict';

const { isTrusted } = require('../access-control/preferences');
const { scopeKey } = require('../local-agent-model-store.cjs');

function install({ ipcMain, runner, scopeOf }) {
  ipcMain.handle('planning-harness-manage', async (event, { action, owner, jobId } = {}) => {
    if (!isTrusted(event)) throw Error('请在当前工作台管理 Planning Harness');
    const scope = scopeOf();
    if (!scope) throw Error('请先登录当前设备');
    const ownerId = scopeKey(scope);
    if (action !== 'status' && owner !== ownerId) throw Error('账号或设备已变化，请刷新后重试');
    const key = 'ai-planning';
    let reply;
    if (action === 'status') {
      reply = await runner.rpc('runtime.detect', { key }, 15000);
    } else if (action === 'job' && /^[a-f0-9]{12}$/.test(jobId)) {
      reply = await runner.rpc('agent.job', { jobId, ownerId }, 15000);
    } else if (['install', 'update', 'uninstall', 'check'].includes(action)) {
      reply = await runner.rpc('agent.install', { key, action, ownerId }, 30000);
    } else {
      throw Error('无效的 Planning 管理请求');
    }
    const current = scopeOf();
    if (!current || scopeKey(current) !== ownerId) throw Error('账号或设备已变化，请刷新后重试');
    if (!reply?.ok || !reply.data) throw Error(reply?.error || '本机 Planning 管理不可用');
    if (['status', 'job'].includes(action) && reply.data.key !== key) throw Error('本机执行机返回了其他底座的信息');
    return action === 'status' ? { owner: ownerId, agent: reply.data } : reply.data;
  });
}

module.exports = { install };
