/*
 * AI dispatch, human transfer, and execution results. Option discovery/UI live in
 * panels-forward-options.js; this module owns side effects and tracking.
 */
function _fwdSubmissionMode() {
  const value = String(document.getElementById('fwdSubmissionMode')?.value || '').trim();
  return value === 'auto' || value === 'manual' ? value : '';
}

let _fwdPluginInputSheet = null;

function _fwdClosePluginInputs() {
  _fwdPluginInputSheet?.close(true);
  _fwdPluginInputSheet = null;
}

function _fwdDispatchConversationPlugin(tid, who, name, plugin) {
  if (_fwdPluginInputSheet?.surface.root.isConnected) return;
  const task = tasks.find(item => _fwdSameId(item.id, tid));
  const note = document.getElementById('fwdNote')?.value.trim() || '';
  const seed = [task?.title, task?.description || task?.note, note].filter(Boolean).join('\n\n');
  const plan = window.ChatPluginMentionModel.prepareConversationInputs(plugin.inputs, seed);
  const dispatch = (inputValues) => _dispatchAITo(tid, who, name, {
    pluginId: plugin.pluginId, name: plugin.name, version: plugin.version, inputValues,
  });
  if (plan.ready) return dispatch(plan.values);
  const scope = window.RequirementAssignment.scope();
  const host = document.getElementById('fwdList');
  const seq = _fwdLoadSeq;
  _fwdPluginInputSheet = window.PluginInputSheet?.open({
    plugin: { ...plugin, inputs: plan.missing }, seed,
    initialValues: plan.values, surfaceContext: 'task',
    submitLabel: '确认派活',
    onApply(_prompt, values) {
      _fwdPluginInputSheet = null;
      if (!window.RequirementAssignment.inScope(scope) || document.getElementById('fwdList') !== host) return;
      const choice = _fwdSelection.ai;
      if (seq !== _fwdLoadSeq || _fwdTab !== 'ai' || plugin !== _fwdConversationPluginOf(_fwdConversationPluginId) ||
          choice?.id !== who.id || !_fwdChoiceIsCurrent(choice) || document.getElementById('fwdConfirm')?.disabled) {
        _fwdSetStatus('执行选项已更新，请重新选择可用选项', true);
        return;
      }
      void dispatch({ ...plan.values, ...values });
    },
    onClose() { _fwdPluginInputSheet = null; document.getElementById('fwdConfirm')?.focus(); },
  });
  if (!_fwdPluginInputSheet) _fwdSetStatus('插件执行组件没有加载成功', true);
}

async function _dispatchNativeTo(tid) {
  const scope = window.RequirementAssignment.scope(), host = document.getElementById('fwdList');
  const current = () => window.RequirementAssignment.inScope(scope) && document.getElementById('fwdList') === host;
  _fwdSetBusy(true, '正在建立会话…');
  try {
    const result = await window.RequirementSessionChoice.executeNative(tid, document.getElementById('fwdNote')?.value.trim() || '', {
      submissionMode: _fwdSubmissionMode(),
    });
    if (current()) await window.RequirementAssignment.completed(tid, scope, result.conversationId);
  } catch (error) {
    if (current()) { _fwdSetBusy(false); _fwdSetStatus(error.message || '会话未能开始，请重试', true); }
  }
}

async function _dispatchAITo(tid, who, name, plugin) {
  const scope = window.RequirementAssignment.scope();
  const brief = (document.getElementById('fwdNote') || {}).value || '';
  const selectedAgent = _fwdSubstrateOf(who.id);
  const canPickModel = typeof _fwdCanPickModel === 'function'
    ? _fwdCanPickModel(selectedAgent) : Boolean(selectedAgent && selectedAgent.modelPick !== false);
  const modelState = typeof _fwdDirectModelState === 'function'
    ? _fwdDirectModelState(selectedAgent, String(document.getElementById('fwdModel')?.value || _fwdModel || ''))
    : { value: canPickModel ? String(document.getElementById('fwdModel')?.value || _fwdModel || '') : '' };
  if (modelState.stale) {
    _fwdSetStatus(modelState.catalogError ? '本地模型配置暂时无法读取，请刷新后重试' : '原模型已不可用，请重新选择', true);
    return;
  }
  const model = modelState.value;
  _fwdSetBusy(true, '正在建立会话…');
  _fwdSetStatus('正在等待执行端接单…');
  try {
    const repo = _pickedRepo();
    const preview = document.getElementById('fwdPrev')?.confirmedInputs;
    if (preview && (preview.taskId !== _fwdId(tid) || !Array.isArray(preview.manifest))) {
      throw new Error(preview.error || '请先重新预览需求附件');
    }
    const executionContext = window.TaskExecutionClient
      ? TaskExecutionClient.context({...(_fwdOptions || {}), substrates:_fwdDirectAgents()}, {
        strategy: 'direct', agentId: who.id, substrateKey: who.id,
        repoId: repo && repo.id, model: model,
      }) : preview ? {strategy: 'direct'} : null;
    const result = await SoduWorkAPI.dispatchToAI(tid, who, brief.trim(), repo, model, executionContext,
      _fwdSubmissionMode(), preview?.manifest, plugin);
    if (!window.RequirementAssignment.inScope(scope)) return;
    if (!result || result.ok === false) {
      const error = new Error((result && (result.reason || result.error || result.message)) ||
        '\u6267\u884c\u673a\u6ca1\u6709\u786e\u8ba4\u63a5\u5355');
      error.detail = error.message;
      throw error;
    }
    const pendingAck = !!(result && result.pending);
    const existingDispatch = !!(result && result.already);
    _closeFwd();
    if (typeof petSay === 'function') petSay(pendingAck ? '派发已送达，正在确认接单。请勿重复派发。' :
      existingDispatch ? name + ' 已经在处理这条需求。' : '已交给 ' + name + '。');
    // The send queue already opened and bound this session. Do not resolve a
    // possibly stale collaboration link again after the task has been accepted.
    try {
      const opened = await window.RequirementAssignment.completed(tid, scope, result.conversationId || '');
      if (opened === false && typeof petSay === 'function') petSay('需求已派发，可从需求详情查看执行进展。');
    } catch (_) {
      if (typeof petSay === 'function') petSay('需求已派发，执行会话暂未打开，请从需求详情查看。');
    }
  } catch (error) {
    if (!window.RequirementAssignment.inScope(scope)) return;
    _fwdSetBusy(false);
    _fwdSetStatus(typeof _humanErr === 'function' ? _humanErr(error, '没有派出去') : '没有派出去', true);
  }
}

async function _handoffTo(tid, userId, name) {
  const scope = window.RequirementAssignment.scope();
  const note = ((document.getElementById('fwdNote') || {}).value || '').trim();
  const task = tasks.find(item => item.id === tid) || {};
  _fwdSetBusy(true, '正在转交…');
  _fwdSetStatus('正在迁移需求归属与协作上下文…');
  try {
    const result = await SoduWorkAPI.handoffTask(tid, userId, note);
    if (!window.RequirementAssignment.inScope(scope)) return;
    if (!result || result.ok === false) {
      const error = new Error((result && (result.reason || result.error || result.message)) ||
        '需求没有成功转交给同事');
      error.detail = error.message;
      throw error;
    }
    _closeFwd();
    const index = tasks.findIndex(item => item.id === tid);
    if (index >= 0) { Store.dropTask(tid); render(); }
    await closeDetail();
    if (typeof petSay === 'function') petSay('“' + (task.title || '') + '”已转给 ' + name + '。');
  } catch (error) {
    if (!window.RequirementAssignment.inScope(scope)) return;
    _fwdSetBusy(false);
    _fwdSetStatus(typeof _humanErr === 'function' ? _humanErr(error, '没有转出去') : '没有转出去', true);
  }
}


function closeDetail() {
  const result = window.RequirementsDetail?.close?.();
  if (result === false) return result;
  if (result && typeof result.then === 'function') {
    return result.then(closed => { if (closed !== false) detailId = null; return closed; });
  }
  detailId = null;
  return result;
}
