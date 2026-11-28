'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { accountScopeKey } = require('../device-auth-request');
const { outputLimit } = require('../conversation/model-selection');
const { compatibility } = require('../model-capability-contract.cjs');

const { events } = require('./planning-model-stream.cjs');
const grants = new Map();
let usageListener = null;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function owner(identity) {
  const account = accountScopeKey(identity);
  if (!identity?.hub || !identity?.clientId || !account) return '';
  return digest(JSON.stringify([identity.hub, identity.clientId, account]));
}
function issue({ app, identity, currentIdentity, runId, cwd, model, operation, input, policy, currentPolicy = () => policy, fetchImpl = global.fetch, onUsage }) {
  const ownerId = owner(identity);
  const current = currentIdentity();
  if (!ownerId || !runId || owner(current) !== ownerId)
    throw Error('Planning 本机身份未就绪，请重新登录');
  if (!model?.key || !model.id || !model.baseUrl || model.localOnly || new URL(model.baseUrl).origin !== new URL(identity.hub).origin)
    throw Error('Planning 需要该底座的企业模型授权');
  const grant = crypto.randomUUID();
  if (!operation || !policy?.revision) throw Error('Planning 本轮缺少执行标识或工作区审批策略');
  const inputDigest = digest(JSON.stringify([input, policy.revision, model.id]));
  const executionId = digest(JSON.stringify([ownerId, runId, operation, inputDigest]));
  const controller = new AbortController();
  const streaming = model.capabilityProfile?.streaming;
  const streamEnabled = streaming?.state === 'supported' && !streaming.conflict;
  // The login token can renew or expire mid-response. Capture the accounting
  // scope while the grant is issued so late usage stays with the original owner.
  const billingScope = usageListener && !onUsage ? require('../conversation/runtime-segments').scope(current) : '';
  // Match the native realpath used for incoming requests, including Windows 8.3 aliases.
  const workspace = fs.realpathSync.native(cwd);
  const record = { ownerId, executionId, streamEnabled, streams: new Map(), billingScope,
    billingIdentity: { hub: current.hub, clientId: current.clientId }, inputDigest, revision: policy.revision, mode: policy.mode, currentPolicy, runId, model, cwd: workspace, app, currentIdentity, controller, fetchImpl, onUsage, modelCalls: new Set() };
  grants.set(grant, record);
  return {
    config: { ...(streamEnabled ? { planningModelStream: true } : {}), planningHostGrant: grant, planningOwnerId: ownerId, planningExecutionId: executionId },
    revoke() { grants.delete(grant); release(record); },
  };
}
function release(record) {
  record.controller.abort();
  for (const stream of record.streams.values()) stream.controller.abort();
  record.streams.clear();
}
function check(record) {
  if (!record || record.controller.signal.aborted) throw Error('Planning 本机授权已失效');
  if (owner(record.currentIdentity()) !== record.ownerId) {
    release(record);
    throw Error('Planning 本机授权已失效');
  }
}
async function fetchModel(record, request, stream, signal) {
  if (!request || !Array.isArray(request.messages) || !request.messages.length)
    throw Error('Planning 模型消息无效');
  const { model } = record;
  const body = { model: model.id, messages: request.messages, stream };
  if (stream && compatibility(model.compatibility).streamOptions === true) body.stream_options = { include_usage: true };
  for (const field of ['tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'stop', 'response_format'])
    if (request[field] !== undefined) body[field] = request[field];
  const requested = request.max_completion_tokens ?? request.max_tokens ?? outputLimit(model);
  if (!Number.isSafeInteger(requested) || requested <= 0) throw Error('Planning 模型输出长度无效');
  body[compatibility(model.compatibility).maxTokensField || 'max_tokens'] = Math.min(requested, outputLimit(model));
  if (model.proxyExpiresAt && Date.now() >= model.proxyExpiresAt) throw Error('Planning 模型授权已过期');
  const response = await record.fetchImpl(model.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', redirect: 'error',
    signal,
    headers: { Authorization: 'Bearer ' + model.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('Planning 模型服务返回 HTTP ' + response.status);
  }
  return response;
}
function account(record, callId, usage) {
  const notify = record.onUsage || usageListener;
  if (usage) notify?.({ identity: record.billingIdentity, accountScope: record.billingScope, sessionId: record.runId,
    receiptId: digest(JSON.stringify([record.ownerId, record.executionId, callId])), model: record.model, usage });
}
async function completion(record, callId, response) {
  const parts = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw Error('Planning 模型响应过大');
    parts.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  check(record);
  if (!result?.choices?.[0]?.message) throw Error('Planning 模型未返回完整消息');
  account(record, callId, result.usage);
  return { choices: result.choices, ...(result.usage ? { usage: result.usage } : {}), model: record.model.id,
    id: result.id, created: result.created, object: 'chat.completion' };
}
// Each local RPC has a 90 s deadline. A live multi-pull stream may outlast
// one request, while an abandoned or stalled provider read must be released.
function armStreamDeadline(stream) {
  clearTimeout(stream.timer);
  stream.timer = setTimeout(() => stream.controller.abort(), 85000);
  stream.timer.unref();
}
function retire(record, id, stream) {
  if (record.streams.get(id) !== stream) return;
  record.streams.delete(id);
  clearTimeout(stream.timer);
  account(record, id, stream.usage);
}
async function closeStream(record, id) {
  const stream = record.streams.get(id);
  if (!stream) return;
  retire(record, id, stream);
  stream.controller.abort();
  // Calling return on a suspended generator releases the body; a pending read
  // is interrupted by AbortController and runs the same generator finally.
  await stream.iterator?.return();
}
async function startModel(record, params, streaming) {
  if (record.modelCalls.has(params.callId)) throw Error('Planning 模型调用标识已使用');
  if (streaming && (!record.streamEnabled || record.streams.size >= 4)) throw Error('Planning 模型流不可用');
  record.modelCalls.add(params.callId);
  const controller = new AbortController();
  const signal = AbortSignal.any([record.controller.signal, controller.signal,
    AbortSignal.timeout(streaming ? 600000 : 85000)]);
  const state = { controller, seq: 0, busy: false };
  if (streaming) { record.streams.set(params.callId, state); armStreamDeadline(state); }
  try {
    const response = await fetchModel(record, params.request, streaming, signal);
    check(record);
    if (streaming && response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
      if (signal.aborted) throw Error('Planning 模型流已关闭');
      state.iterator = events(response.body, signal);
      signal.addEventListener('abort', () => {
        retire(record, params.callId, state);
        void state.iterator.return().catch(() => {});
      }, { once: true });
      return { started: true };
    }
    const result = await completion(record, params.callId, response);
    return streaming ? { completion: result } : result;
  } finally {
    if (!state.iterator) {
      clearTimeout(state.timer);
      record.streams.delete(params.callId);
      controller.abort();
    }
  }
}
async function nextChunk(record, params) {
  const stream = record.streams.get(params.callId);
  if (!stream?.iterator || stream.busy || params.seq !== stream.seq) throw Error('Planning 模型流序号或状态无效');
  stream.busy = true;
  armStreamDeadline(stream);
  try {
    const { done, value } = await stream.iterator.next();
    check(record);
    if (stream.controller.signal.aborted) throw Error('Planning 模型流已关闭');
    if (done) {
      await closeStream(record, params.callId);
      return { chunks: [], done: true };
    }
    if (value.usage) stream.usage = value.usage;
    stream.seq++;
    armStreamDeadline(stream);
    return { chunks: [value], done: false };
  } catch (error) {
    await closeStream(record, params.callId);
    throw error;
  } finally { stream.busy = false; }
}
async function verifiedArtifact(root, artifact) {
  if (!artifact || typeof artifact.path !== 'string' || !artifact.path || !/^[a-f0-9]{64}$/.test(artifact.sha256 || ''))
    throw Error('Planning 产物声明无效');
  const absolute = await fs.promises.realpath(path.resolve(root, artifact.path));
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Planning 产物超出工作区');
  const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Error('Planning 产物不是普通文件');
    const hash = crypto.createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await fs.promises.stat(absolute);
    if (hash.digest('hex') !== artifact.sha256 || before.dev !== after.dev || before.ino !== after.ino ||
        before.mtimeMs !== after.mtimeMs || absolute !== await fs.promises.realpath(absolute))
      throw Error('Planning 产物校验失败');
    return { path: artifact.path, sha256: artifact.sha256 };
  } finally { await handle.close(); }
}
async function authorizeFile(record, params, workbook) {
  const { operation, path: target, sha256 } = params;
  if (!['read', 'write'].includes(operation)) throw Error('Planning 文件操作无效');
  if (typeof target !== 'string' || !target || workbook && path.extname(target).toLowerCase() !== '.xlsx')
    throw Error('Planning 文件路径无效');
  if (operation === 'write' && (!['standard', 'full'].includes(record.mode) || !/^[0-9a-f]{64}$/.test(sha256 || '')))
    throw Error('Planning 写入授权或内容摘要无效');
  const dest = path.resolve(record.cwd, target);
  const relative = path.relative(record.cwd, dest);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw Error('Planning 文件超出工作区');
  // Attachment aliases name Runner-owned immutable inputs and have no on-disk parent here.
  const parts = relative.split(path.sep);
  const attachment = /^\.soduwork-inputs-[a-f0-9]{24}$/.test(parts[0]);
  if (attachment) {
    if (operation !== 'read' || parts.length !== 2) throw Error('Planning 附件仅支持读取');
  } else {
    const parent = await fs.promises.realpath(path.dirname(dest));
    const within = path.relative(record.cwd, parent);
    if (within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within))
      throw Error('Planning 文件超出工作区');
    try {
      const existing = await fs.promises.lstat(path.join(parent, path.basename(dest)));
      if (!existing.isFile() || existing.isSymbolicLink()) throw Error('Planning 文件目标无效');
      if (workbook && operation === 'write') throw Error('Planning 工作簿已存在，请另选名称');
    } catch (error) { if (error.code !== 'ENOENT' || operation !== 'write') throw error; }
  }
  check(record);
  if (record.currentPolicy()?.revision !== record.revision) throw Error('Planning 工作区权限已变更');
  return { authorized: true };
}
async function commit(record, params) {
  if (!Array.isArray(params.artifacts) || params.artifacts.length > 100) throw Error('Planning 产物清单无效');
  const root = await fs.promises.realpath(record.cwd);
  const artifacts = [];
  for (const artifact of params.artifacts) artifacts.push(await verifiedArtifact(root, artifact));
  check(record);
  const receiptId = digest(JSON.stringify([record.ownerId, record.runId, root, params.sessionId, record.executionId, params.callId]));
  const receipt = { receiptId, artifacts };
  const contents = JSON.stringify({ ...receipt, inputDigest: record.inputDigest, revision: record.revision,
    summaryDigest: digest(String(params.summary || '')) });
  const dir = path.join(record.app.getPath('userData'), 'planning-receipts', record.ownerId);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, receiptId + '.json');
  const tmp = file + '.' + crypto.randomUUID();
  try {
    await fs.promises.writeFile(tmp, contents, { mode: 0o600, flag: 'wx' });
    check(record);
    try { await fs.promises.link(tmp, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fs.promises.readFile(file, 'utf8') !== contents) throw Error('Planning 重复提交的产物与原回执冲突');
    }
  } finally { await fs.promises.rm(tmp, { force: true }); }
  return receipt;
}
async function request(body) {
  const record = grants.get(body?.grant);
  check(record);
  const p = body?.params;
  if (body.runId !== record.runId || p?.executionId !== record.executionId ||
      ![p.sessionId, p.callId].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256))
    throw Error('Planning 请求与已授权执行不匹配');
  if (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace) ||
      await fs.promises.realpath(body.workspace) !== record.cwd) throw Error('Planning 请求工作区与本机授权不匹配');
  check(record);
  if (record.sessionId && record.sessionId !== p.sessionId) throw Error('Planning 请求不属于当前会话');
  record.sessionId = p.sessionId;
  if (body.method === 'model' || body.method === 'model.start') return startModel(record, p, body.method === 'model.start');
  if (body.method === 'model.next') return nextChunk(record, p);
  if (body.method === 'model.close') { await closeStream(record, p.callId); return { closed: true }; }
  if (['fs.authorize', 'workbook.authorize'].includes(body.method))
    return authorizeFile(record, p, body.method === 'workbook.authorize');
  if (body.method === 'commit') return commit(record, p);
  throw Error('Planning 宿主方法不受支持');
}
module.exports = { issue, request, setUsageListener(listener) { usageListener = listener; } };
