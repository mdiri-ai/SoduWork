"""ACP diagnostics and DSH output recovery preserve native execution evidence."""
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge as bridge


class AcpErrorMessagesTests(unittest.TestCase):
    raw = (r"Internal error: turn failed: MoveFileExW EXDEV (Win32 17): "
           r"D:\private\.dsh\sessions\project\session\session.v4.jsonl.zstd.abc123.tmp"
           r" -> D:\private\.dsh\sessions\project\session\session.v4.jsonl.zstd")

    def setUp(self):
        environment = patch.dict(bridge.os.environ, {
            'SODUWORK_APPROVAL_CHANNEL': '', bridge.runtime_images.ENV_KEY: '',
            bridge._TASK_OUTPUT_RECOVERY_ENV: '',
        })
        environment.start()
        self.addCleanup(environment.stop)

    def test_host_cancellation_sends_one_notification_and_cancels_pending_permission(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, "dsh", "workspace", session_id="bound-session")
            acp.access = SimpleNamespace(enabled=True, call=Mock(return_value={"stopRequested": True}))
            acp.send = Mock()
            acp.inbox.put(("message", {"jsonrpc": "2.0", "id": "permission", "method": "session/request_permission",
                                       "params": {"sessionId": "bound-session", "options": []}}))
            acp.inbox.put(("message", {"jsonrpc": "2.0", "id": 1, "result": {"stopReason": "cancelled"}}))
            self.assertEqual(acp.request("session/prompt", {"sessionId": "bound-session"}), {"stopReason": "cancelled"})
            acp.transition.next_poll = 0
            acp.transition.tick("session/prompt")
        messages = [call.args[0] for call in acp.send.call_args_list]
        self.assertEqual(messages[1:], [
            {"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "bound-session"}},
            {"jsonrpc": "2.0", "id": "permission", "result": {"outcome": {"outcome": "cancelled"}}},
        ])

    def test_standard_native_cancelled_receipt_is_not_an_adapter_error(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, "dsh", "workspace")
            with patch.object(acp, "start"), patch.object(acp, "request", side_effect=[
                {"protocolVersion": 1}, {"sessionId": "bound-session"}, {"stopReason": "cancelled"},
            ]), patch.object(bridge, "_emit") as emit:
                self.assertEqual(acp.run("Synthetic task"), 0)
            emit.assert_any_call({"type": "turn_stopped", "reason": "cancelled"})

    def test_host_cancellation_during_dsh_compaction_keeps_a_neutral_outcome(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, "dsh", "workspace", session_id="bound-session")
            acp.dsh_compact_only = True
            acp.dsh_can_compact = True

            def request(method, _params):
                if method == "initialize":
                    return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
                if method == "session/load":
                    return {}
                self.assertEqual(method, "session/prompt")
                acp.transition.stop_requested = True
                return {"stopReason": "cancelled"}

            with patch.object(acp, "start"), patch.object(acp, "request", side_effect=request), \
                    patch.object(acp, "_dsh_compaction_available", return_value=True), \
                    patch.object(bridge, "_emit") as emit:
                self.assertEqual(acp.run(""), 0)
            emit.assert_any_call({"type": "turn_stopped", "reason": "cancelled"})
            self.assertNotIn("dsh_context_compaction_failed", str(emit.call_args_list))

    def test_known_dsh_storage_error_is_actionable_and_keeps_original(self):
        for message in (self.raw, self.raw.replace("\\", "/"),
                        self.raw.replace(".zstd", "")):
            with self.subTest(message=message):
                result = bridge._friendly_bridge_error("dsh", message)
                self.assertIn("无法保存本机会话归档", result)
                self.assertIn("本次执行未完成", result)
                self.assertIn("重新登录或放宽工具权限不能解决", result)
                self.assertTrue(result.endswith("原始信息：" + message))

    def test_other_agents_keep_their_native_error(self):
        for agent in ("qwen", "opencode", "codex-harness", "acp", "dsh-other"):
            with self.subTest(agent=agent):
                self.assertEqual(bridge._friendly_bridge_error(agent, self.raw), self.raw)

    def test_unrelated_paths_and_error_codes_are_not_classified(self):
        cases = [self.raw.replace("session.v4.jsonl", name) for name in (
            "auth.json", "session.v3.jsonl", "session.v4.jsonl-other", "workspace.json")]
        cases += [self.raw.replace("EXDEV (Win32 17)", name) for name in (
            "EACCES (Win32 5)", "ENOENT (Win32 2)", "EXDEV", "EXDEV (Win32 117)")]
        cases.append(self.raw.replace("MoveFileExW", "rename"))
        for message in cases:
            with self.subTest(message=message):
                self.assertEqual(bridge._friendly_bridge_error("dsh", message), message)

    def test_authentication_guidance_still_preserves_original(self):
        message = "Authentication required: Use Qwen Code CLI to authenticate first."
        result = bridge._friendly_bridge_error("qwen", message)
        self.assertIn("qwen 缺少可用的模型凭据", result)
        self.assertTrue(result.endswith("原始信息：" + message))

    def test_unknown_error_is_unchanged(self):
        message = "Internal error: upstream unavailable"
        self.assertEqual(bridge._friendly_bridge_error("dsh", message), message)

    def test_client_resource_failures_return_acp_error_codes(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'readonly', session_id='native')
            path = Path(folder) / 'file.txt'
            path.write_text('fixture')
            for method, params, expected in [
                ('fs/read_text_file', {'path': str(path), 'line': 0}, -32602),
                ('fs/read_text_file', {'path': str(path.with_suffix('.missing'))}, -32002),
                ('fs/write_text_file', {'path': str(path), 'content': 'other'}, -32601),
            ]:
                with self.subTest(method=method, expected=expected), patch.object(acp, 'send') as send:
                    acp._incoming({'id': 1, 'method': method, 'params': {'sessionId': 'native', **params}})
                    self.assertEqual(send.call_args.args[0]['error']['code'], expected)
            self.assertEqual(path.read_text(), 'fixture')

    def test_missing_prompt_stop_reason_is_a_protocol_error(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'readonly')
            with patch.object(acp, 'start'), patch.object(acp.access, 'apply'), patch.object(bridge, '_emit'), \
                    patch.object(acp, 'request', side_effect=[{'protocolVersion': 1}, {'sessionId': 'native'}, {}]):
                with self.assertRaisesRegex(bridge.BridgeError, 'missing stopReason'):
                    acp.run('test')

    def test_kimi_and_verified_qwen_output_limits_do_not_add_host_retries(self):
        cases = [
            ('kimi', {}, True),
            ('qwen', {'soduwork': {'outputLimit': True}}, True),
            ('qwen', {}, False),
            ('qwen', {'soduwork': {'outputLimit': 'true'}}, False),
            ('qwen', {'soduwork': {'outputLimit': 1}}, False),
            ('qwen', {'soduwork': 'outputLimit'}, False),
            ('qwen', [], False),
            ('other', {'soduwork': {'outputLimit': True}}, False),
        ]
        for agent, metadata, incomplete in cases:
            with self.subTest(agent=agent, metadata=metadata), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace', session_id='retained-native')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                    self.assertEqual(params['sessionId'], 'retained-native')
                    if method == 'session/load':
                        return {}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'])
                    return {'stopReason': 'max_tokens', '_meta': metadata}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge.qwen_runtime, 'apply_model'), \
                        patch.object(bridge, '_emit') as emit:
                    if incomplete:
                        self.assertEqual(acp.run('Preserve existing work'), 2)
                    else:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run('Preserve existing work')
                self.assertEqual(prompts, [[{'type': 'text', 'text': 'Preserve existing work'}]])
                endings = [call.args[0]['part']['reason'] for call in emit.call_args_list
                           if call.args[0].get('type') == 'step_finish']
                self.assertEqual(endings, ['max_tokens'] if incomplete else [])

    def test_dsh_output_recovery_is_bounded_and_keeps_the_original_session(self):
        compacted = 'Compacted 4 history items (~32000 tokens).'
        for agent, reasons, tool_status, compact_reply, resumes, succeeds in [
            ('dsh', ['max_tokens', 'end_turn'], None, None, 1, True),
            ('dsh', ['max_tokens', 'max_tokens'], None, None, 1, False),
            ('dsh', ['max_tokens', 'max_tokens', 'end_turn'], None, compacted, 2, True),
            ('dsh', ['max_tokens'] * 3, None, compacted, 2, False),
            ('dsh', ['max_tokens'] * 2, None, 'No compactable history yet.', 1, False),
            ('dsh', ['max_tokens'] * 2, None, '⚠ Compaction cancelled.', 1, False),
            ('dsh', ['max_tokens'], 'in_progress', compacted, 0, False),
            ('dsh', ['max_tokens'], 'pending', compacted, 0, False),
            ('qwen', ['max_tokens'], None, None, 0, False),
        ]:
            with self.subTest(agent=agent, reasons=reasons, tool_status=tool_status, compact_reply=compact_reply), \
                    TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace')
                seen = []
                stops = iter(reasons)

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1}
                    if method == 'session/new':
                        if compact_reply is not None:
                            acp._update({'sessionUpdate': 'available_commands_update',
                                         'availableCommands': [{'name': 'compact'}]})
                        return {'sessionId': 'existing-tools'}
                    self.assertEqual(method, 'session/prompt')
                    seen.append(params)
                    if params['prompt'][0]['text'] == '/compact':
                        acp._update({'sessionUpdate': 'agent_message_chunk',
                                     'content': {'type': 'text', 'text': compact_reply}})
                        return {'stopReason': 'end_turn'}
                    if tool_status:
                        acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'running-tool',
                                     'title': 'Unsettled fixture', 'status': tool_status})
                    reason = next(stops)
                    if agent == 'dsh' and (reason == 'end_turn' or compact_reply and len(seen) == 2):
                        acp._update({'sessionUpdate': 'agent_message_chunk',
                                     'content': {'type': 'text', 'text': 'New work from this prompt'}})
                    return {'stopReason': reason}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), \
                        patch.object(bridge.qwen_runtime, 'apply_model'), patch.object(bridge, '_emit') as emit:
                    if succeeds:
                        self.assertEqual(acp.run('Original synthetic task'), 0)
                    elif agent == 'dsh':
                        self.assertEqual(acp.run('Original synthetic task'), 2)
                    else:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run('Original synthetic task')
                self.assertEqual({p['sessionId'] for p in seen}, {'existing-tools'})
                texts = [p['prompt'][0]['text'] for p in seen]
                expected = ['Original synthetic task'] + [bridge._DSH_OUTPUT_CONTINUATION] * resumes
                if compact_reply is not None and resumes:
                    expected.insert(2, '/compact')
                self.assertEqual(texts, expected)
                if agent == 'dsh':
                    finish_reasons = [call.args[0]['part']['reason'] for call in emit.call_args_list
                                      if call.args[0].get('type') == 'step_finish'
                                      and not call.args[0].get('contextOnly')]
                    self.assertEqual(finish_reasons, [
                        'stop' if reason == 'end_turn' else reason for reason in reasons])
                    self.assertFalse(any(call.args[0].get('error')
                                         for call in emit.call_args_list))
                if compact_reply:
                    self.assertNotIn(compact_reply, str(emit.call_args_list))

    def test_dsh_recovery_requires_new_evidence_and_stops_repeating_without_it(self):
        for evidence, final_reason, expected_stop in [
            ('empty', 'end_turn', 'output_recovery_no_progress'),
            ('stale-tool', 'end_turn', 'output_recovery_no_progress'),
            ('failed-tool', 'end_turn', 'output_recovery_no_progress'),
            ('thinking', 'max_tokens', 'reasoning_output_limit'),
            ('thinking', 'end_turn', 'output_recovery_no_progress'),
            ('repeated-thinking', 'max_tokens', 'reasoning_output_limit'),
            ('thinking-then-answer', 'end_turn', None),
            ('thinking-then-tool', 'end_turn', None),
            ('child-thinking', 'max_tokens', 'output_recovery_no_progress'),
            ('new-tool', 'end_turn', None),
            ('host-write', 'end_turn', None),
        ]:
            with self.subTest(evidence=evidence), TemporaryDirectory() as workspace:
                acp = bridge.AcpBridge([], workspace, 'dsh', 'workspace')
                prompts = []

                def notify(kind, **fields):
                    acp._update({'sessionUpdate': kind, **fields})

                def tool(identity, status):
                    notify('tool_call', toolCallId=identity, status='in_progress')
                    notify('tool_call_update', toolCallId=identity, status=status)

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1}
                    if method == 'session/new':
                        notify('available_commands_update', availableCommands=[{'name': 'compact'}])
                        return {'sessionId': 'original-session'}
                    self.assertEqual(method, 'session/prompt')
                    self.assertEqual(params['sessionId'], 'original-session')
                    prompts.append(params['prompt'][0]['text'])
                    if len(prompts) == 1:
                        if evidence in {'repeated-thinking', 'thinking-then-answer', 'thinking-then-tool'}:
                            notify('agent_thought_chunk', content={'type': 'text', 'text': 'Initial thinking'})
                        else:
                            notify('agent_message_chunk', content={'type': 'text', 'text': 'Earlier truncated answer'})
                            tool('previous-call', 'completed')
                        return {'stopReason': 'max_tokens'}
                    self.assertEqual(len(prompts), 2)
                    notify('agent_message_chunk', content={'type': 'text', 'text': '  '})
                    if evidence in {'thinking', 'repeated-thinking', 'child-thinking'}:
                        notify('agent_thought_chunk', content={'type': 'text', 'text': 'Thinking only'},
                               _meta={'dsh': {'subagent': evidence == 'child-thinking'}})
                    if evidence == 'stale-tool':
                        tool('previous-call', 'completed')
                    if evidence in {'new-tool', 'failed-tool'}:
                        tool('new-call', 'completed' if evidence == 'new-tool' else 'failed')
                    if evidence == 'thinking-then-answer':
                        notify('agent_message_chunk', content={'type': 'text', 'text': 'Verified answer'})
                    if evidence == 'thinking-then-tool':
                        tool('recovery-tool', 'completed')
                    if evidence == 'host-write':
                        acp._write_text_file({'path': str(Path(workspace) / 'result.txt'), 'content': 'new work'})
                    return {'stopReason': final_reason}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit, \
                        patch.object(acp, '_compact_dsh_history') as compact:
                    self.assertEqual(acp.run('Original synthetic task'), 2 if expected_stop else 0)
                continuation = (bridge._DSH_REASONING_CONTINUATION
                                if evidence in {'repeated-thinking', 'thinking-then-answer', 'thinking-then-tool'}
                                else bridge._DSH_OUTPUT_CONTINUATION)
                expected_prompts = ['Original synthetic task', continuation]
                self.assertEqual(prompts, expected_prompts)
                compact.assert_not_called()
                events = [call.args[0] for call in emit.call_args_list]
                self.assertEqual([item['reason'] for item in events if item['type'] == 'turn_stopped'],
                                 [expected_stop] if expected_stop else [])
                self.assertEqual([item['part']['reason'] for item in events if item['type'] == 'step_finish'],
                                 ['max_tokens', 'stop' if final_reason == 'end_turn' else 'max_tokens'])

    def test_task_owned_recovery_does_not_multiply_retries_across_bridge_restarts(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            # Each new bridge attaches to the same native session. Neither an
            # output limit nor an available compact command grants extra tries.
            for _attempt in range(3):
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-task')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                    self.assertEqual(params['sessionId'], 'saved-task')
                    if method == 'session/load':
                        acp.dsh_can_compact = True
                        return {}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'][0]['text'])
                    return {'stopReason': 'max_tokens'}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit, \
                        patch.object(acp, '_compact_dsh_history') as compact:
                    self.assertEqual(acp.run('Continue the retained task'), 2)
                compact.assert_not_called()
                self.assertEqual(prompts, ['Continue the retained task'])
                self.assertEqual([call.args[0]['part']['reason'] for call in emit.call_args_list
                                  if call.args[0].get('type') == 'step_finish'], ['max_tokens'])
                self.assertFalse(any(call.args[0].get('error') for call in emit.call_args_list))

    def test_task_owned_recovery_requires_the_exact_host_flag(self):
        with TemporaryDirectory() as folder:
            for value in ('', '0', 'true', 'yes', '1 ', '1'):
                with self.subTest(value=value), patch.dict(bridge.os.environ, {
                        bridge._TASK_OUTPUT_RECOVERY_ENV: value}):
                    acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                    self.assertEqual(acp.task_output_recovery_owned, value == '1')

    def test_task_recovery_control_is_not_exposed_to_native_agent_tools(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            acp = bridge.AcpBridge(['synthetic-agent'], folder, 'dsh', 'workspace')
            with patch.object(bridge.subprocess, 'Popen') as spawn, \
                    patch.object(bridge, 'OwnedProcessGroup'), patch.object(bridge.threading, 'Thread'):
                acp.start()
            self.assertTrue(acp.task_output_recovery_owned)
            self.assertNotIn(bridge._TASK_OUTPUT_RECOVERY_ENV, spawn.call_args.kwargs['env'])

    def test_task_owned_recovery_never_masks_a_protocol_or_context_failure(self):
        with TemporaryDirectory() as folder, patch.dict(bridge.os.environ, {
                bridge._TASK_OUTPUT_RECOVERY_ENV: '1'}):
            for error in ('Connection closed', 'context_length_exceeded'):
                with self.subTest(error=error):
                    acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                    prompts = []

                    def request(method, params):
                        if method == 'initialize':
                            return {'protocolVersion': 1}
                        if method == 'session/new':
                            return {'sessionId': 'saved-task'}
                        prompts.append(params['prompt'])
                        raise bridge.BridgeError(error)

                    with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                            patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                        with self.assertRaisesRegex(bridge.BridgeError, error):
                            acp.run('Continue the retained task')
                    self.assertEqual(len(prompts), 1)
                    self.assertFalse(any(call.args[0].get('type') == 'step_finish'
                                         for call in emit.call_args_list))

    def test_dsh_unexecuted_preview_allows_one_continuation_in_the_saved_session(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-tools')
            methods, prompts = [], []

            def request(method, params):
                methods.append(method)
                if method == 'initialize':
                    return {'protocolVersion': 1, 'agentCapabilities': {'loadSession': True}}
                self.assertEqual(params['sessionId'], 'saved-tools')
                if method == 'session/load':
                    return {}
                self.assertEqual(method, 'session/prompt')
                prompts.append(params['prompt'][0]['text'])
                if len(prompts) == 1:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'completed-edit',
                                 'title': 'Completed edit', 'status': 'in_progress'})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'completed-edit',
                                 'status': 'completed'})
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'partial-edit',
                                 'title': 'Partial edit', 'status': 'pending',
                                 'rawInput': {'path': 'synthetic.txt'}})
                    self.assertTrue(acp.transition.busy())
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'partial-edit',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    self.assertFalse(acp.transition.busy())
                    return {'stopReason': 'max_tokens'}
                self.assertEqual(len(prompts), 2, 'Only the saved-session continuation may follow')
                self.assertEqual(acp.transition.tools['completed-edit'], 'completed')
                self.assertEqual(acp.transition.tools['partial-edit'], 'failed')
                acp._update({'sessionUpdate': 'agent_message_chunk',
                             'content': {'type': 'text', 'text': 'New recovery result'}})
                return {'stopReason': 'end_turn'}

            with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                    patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                self.assertEqual(acp.run('Original synthetic task'), 0)
            self.assertEqual(methods, ['initialize', 'session/load', 'session/prompt', 'session/prompt'])
            self.assertEqual(prompts, ['Original synthetic task', bridge._DSH_OUTPUT_CONTINUATION])
            events = [call.args[0] for call in emit.call_args_list]
            endings = [event for event in events if event.get('type') == 'tool_execution_end']
            self.assertEqual(len(endings), 2)
            preview = next(event for event in endings if event['toolCallId'] == 'partial-edit')
            self.assertEqual(preview['state'], 'cancelled')
            self.assertEqual(preview['cancelReason'], 'output-limit')
            self.assertIs(preview['isError'], False)
            self.assertEqual([event['part']['reason'] for event in events
                              if event.get('type') == 'step_finish'], ['max_tokens', 'stop'])

    def test_dsh_started_tool_rejects_unexecuted_marker_and_blocks_continuation(self):
        for statuses in (('in_progress',), ('pending', 'in_progress'),
                         ('in_progress', 'pending')):
            with self.subTest(statuses=statuses), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                prompts = []

                def request(method, params):
                    if method == 'initialize':
                        return {'protocolVersion': 1}
                    if method == 'session/new':
                        return {'sessionId': 'running-tools'}
                    self.assertEqual(method, 'session/prompt')
                    prompts.append(params['prompt'][0]['text'])
                    self.assertEqual(len(prompts), 1, 'A started tool must block automatic continuation')
                    for index, status in enumerate(statuses):
                        acp._update({'sessionUpdate': 'tool_call' if index == 0 else 'tool_call_update',
                                     'toolCallId': 'running-edit', 'status': status})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'running-edit',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    self.assertTrue(acp.transition.busy())
                    self.assertEqual(acp.transition.tools['running-edit'], statuses[-1])
                    return {'stopReason': 'max_tokens'}

                with patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                        patch.object(acp.access, 'apply'), patch.object(bridge, '_emit') as emit:
                    self.assertEqual(acp.run('Original synthetic task'), 2)
                self.assertEqual(prompts, ['Original synthetic task'])
                self.assertFalse(any(call.args[0].get('type') == 'tool_execution_end'
                                     for call in emit.call_args_list))

    def test_only_known_pending_dsh_previews_receive_output_limit_cancellation(self):
        marker = {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'output-limit'}}
        cases = [
            ('dsh', 'pending', None),
            ('dsh', 'pending', {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'other'}}),
            ('dsh', 'pending', {'soduwork': {'toolOutcome': 'failed', 'reason': 'output-limit'}}),
            ('dsh', 'pending', {'soduwork': 'not-executed'}),
            ('dsh', 'pending', 'not-executed'),
            ('dsh', None, marker),
            ('dsh', 'completed', marker),
            ('qwen', 'pending', marker),
            ('codex-harness', 'pending', marker),
            ('opencode', 'pending', marker),
        ]
        for agent, previous, metadata in cases:
            with self.subTest(agent=agent, previous=previous, metadata=metadata), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace')
                with patch.object(bridge, '_emit') as emit:
                    if previous:
                        acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'untrusted-preview',
                                     'status': previous})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'untrusted-preview',
                                 'status': 'failed', '_meta': metadata})
                endings = [call.args[0] for call in emit.call_args_list
                           if call.args[0].get('type') == 'tool_execution_end']
                if agent == 'dsh' and metadata == marker and previous in (None, 'completed'):
                    self.assertEqual(endings, [])
                    self.assertEqual(acp.transition.tools.get('untrusted-preview'), previous)
                    continue
                self.assertEqual(len(endings), 1)
                self.assertIs(endings[0]['isError'], True)
                self.assertNotIn('cancelReason', endings[0])
                self.assertNotEqual(endings[0].get('state'), 'cancelled')

    def test_dsh_duplicate_marker_and_reused_tool_ids_preserve_each_execution(self):
        with TemporaryDirectory() as folder:
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
            marker = {'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                      'status': 'failed', '_meta': {'soduwork': {
                          'toolOutcome': 'not-executed', 'reason': 'output-limit'}}}
            with patch.object(bridge, '_emit') as emit:
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'in_progress'})
                acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                             'status': 'completed'})
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'pending'})
                acp._update(marker)
                acp._update(marker)
                self.assertFalse(acp.transition.busy())
                acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'reused-tool',
                             'status': 'in_progress'})
                self.assertTrue(acp.transition.busy())
                acp._update(marker)
                self.assertTrue(acp.transition.busy())
                acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'reused-tool',
                             'status': 'failed'})
                acp._update(marker)
            endings = [call.args[0] for call in emit.call_args_list
                       if call.args[0].get('type') == 'tool_execution_end']
            self.assertEqual(len(endings), 3, 'Duplicate and conflicting markers must emit no terminal event')
            self.assertIs(endings[0]['isError'], False)
            self.assertNotIn('cancelReason', endings[0])
            self.assertEqual(endings[1]['cancelReason'], 'output-limit')
            self.assertIs(endings[1]['isError'], False)
            self.assertIs(endings[2]['isError'], True)
            self.assertNotIn('cancelReason', endings[2])

    def test_dsh_later_real_failure_overrides_an_earlier_discard_marker(self):
        for starts_late in (False, True):
            with self.subTest(starts_late=starts_late), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')
                with patch.object(bridge, '_emit') as emit:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'late-failure',
                                 'status': 'pending'})
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                 'status': 'failed', '_meta': {'soduwork': {
                                     'toolOutcome': 'not-executed', 'reason': 'output-limit'}}})
                    if starts_late:
                        acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                     'status': 'in_progress'})
                        self.assertTrue(acp.transition.busy())
                    acp._update({'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-failure',
                                 'status': 'failed', 'content': [
                                     {'type': 'content', 'content': {'type': 'text', 'text': 'Real execution failed'}}]})
                endings = [call.args[0] for call in emit.call_args_list
                           if call.args[0].get('type') == 'tool_execution_end']
                self.assertEqual(len(endings), 2)
                self.assertEqual(endings[0]['cancelReason'], 'output-limit')
                self.assertIs(endings[1]['isError'], True)
                self.assertNotIn('cancelReason', endings[1])
                self.assertIn('Real execution failed', endings[1]['result'])

    def test_dsh_discarded_preview_does_not_fail_a_pending_permission_change(self):
        for started in (False, True):
            with self.subTest(started=started), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'dsh', 'workspace', session_id='saved-tools')
                acp.access.channel = {}
                acp.transition.cancel_sent = True
                acp.transition.requested = 'change-1'
                terminal = {'sessionUpdate': 'tool_call_update', 'toolCallId': 'late-tool', 'status': 'failed'}
                if not started:
                    terminal['_meta'] = {'soduwork': {'toolOutcome': 'not-executed', 'reason': 'output-limit'}}
                with patch.object(bridge, '_emit'), patch.object(acp.access, 'call',
                        return_value={'requested': True, 'id': 'change-1'}) as control:
                    acp._update({'sessionUpdate': 'tool_call', 'toolCallId': 'late-tool',
                                 'status': 'in_progress' if started else 'pending'})
                    acp._update(terminal)
                    self.assertFalse(acp.transition.busy())
                    self.assertEqual(acp.transition.failed_after_cancel, {'late-tool'} if started else set())
                    self.assertEqual(acp.transition.complete({'stopReason': 'cancelled'}), not started)
                self.assertEqual(control.call_args.args[1]['stage'], 'failed' if started else 'ready')

    def test_real_bridge_entry_emits_failure_and_always_closes(self):
        args = SimpleNamespace(agent=["fixture"], cwd="fixture", agent_name="dsh",
                               permission="workspace", session="", terminal=False)
        agent = Mock(agent_name="dsh")
        agent.run.side_effect = bridge.BridgeError(self.raw)
        output = io.StringIO()
        with patch.object(bridge, "_parse", return_value=args), \
                patch.object(bridge, "_utf8_stdio"), \
                patch.object(bridge, "AcpBridge", return_value=agent), \
                patch.object(bridge.sys, "stdin", io.StringIO("synthetic")), \
                patch.object(bridge.sys, "stdout", output):
            code = bridge.main()
        self.assertEqual(code, 2)
        event = json.loads(output.getvalue())
        self.assertEqual(event["error"]["name"], "AcpBridgeError")
        self.assertEqual(event["error"]["message"], bridge._friendly_bridge_error("dsh", self.raw))
        agent.run.assert_called_once_with("synthetic")
        agent.close.assert_called_once_with()

    def test_armonel_reports_the_native_summary_stop_without_replaying_the_prompt(self):
        prefix = 'Task stopped: compaction_failed. '
        for detail, expected in (
            ('Context summary failed before replacing history: Summary was truncated again on a smaller segment; original history was preserved',
             'context_summary_truncated'),
            ('Context summary failed before replacing history: Unknown internal detail', 'context_summary_failed'),
            ('Unknown internal detail', 'context_summary_failed'),
        ):
            with self.subTest(reason=expected), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, 'armonel', 'workspace')
                replies = [{'protocolVersion': 1, 'agentInfo': {'name': 'armonel'},
                            'agentCapabilities': {'loadSession': True}},
                           {'sessionId': 'original-session'}, bridge.BridgeError(prefix + detail)]
                with patch.object(acp, 'start'), patch.object(acp.access, 'apply'), \
                        patch.object(acp, 'request', side_effect=replies) as request, \
                        patch.object(bridge, '_emit') as emit:
                    self.assertEqual(acp.run('synthetic'), 2)
                self.assertEqual([call.args[0] for call in request.call_args_list],
                                 ['initialize', 'session/new', 'session/prompt'])
                self.assertEqual(emit.call_args.args[0], {'type': 'turn_stopped', 'reason': expected})

    def test_context_contract_is_an_armonel_prompt_stop_and_never_exposes_detail(self):
        internal = {'code': -32603, 'message': 'Task stopped: context_contract. private diagnostic'}
        meta = {'armonel/stopReason': 'context_contract'}
        for agent, payload, outcome in (
            ('armonel', {'error': internal}, 2),
            ('armonel', {'result': {'stopReason': 'refusal', '_meta': meta}}, 2),
            ('armonel', {'result': {'stopReason': 'end_turn', '_meta': meta}}, 2),
            ('armonel', {'result': {'stopReason': 'context_contract'}}, 2),
            ('kimi', {'result': {'stopReason': 'end_turn', '_meta': meta}}, 0),
            ('kimi', {'error': internal}, None),
            ('armonel', {'error': {**internal, 'code': -32602}}, None),
            ('armonel', {'error': {**internal, 'message': 'Unknown failure: ' + internal['message']}}, None),
        ):
            with self.subTest(agent=agent, payload=payload), TemporaryDirectory() as folder:
                acp = bridge.AcpBridge([], folder, agent, 'workspace')
                def request(method, _params):
                    if method == 'initialize':
                        return {'protocolVersion': 1, 'agentInfo': {'name': agent},
                                'agentCapabilities': {'loadSession': True}}
                    if method == 'session/new':
                        return {'sessionId': 'fixture-session'}
                    self.assertEqual(method, 'session/prompt')
                    return acp._unwrap(payload)
                with patch.object(acp, 'start'), patch.object(acp.access, 'apply'), \
                        patch.object(acp, 'request', side_effect=request) as calls, patch.object(bridge, '_emit') as emit:
                    if outcome is None:
                        with self.assertRaises(bridge.BridgeError):
                            acp.run('synthetic')
                    else:
                        self.assertEqual(acp.run('synthetic'), outcome)
                self.assertEqual(sum(call.args[0] == 'session/prompt' for call in calls.call_args_list), 1)
                stops = [call.args[0] for call in emit.call_args_list if call.args[0].get('type') == 'turn_stopped']
                self.assertEqual(stops, [{'type': 'turn_stopped', 'reason': 'context_contract'}] if outcome == 2 else [])
                self.assertNotIn('private diagnostic', str(emit.call_args_list))

    def test_dsh_output_limit_entry_returns_two_without_an_adapter_error(self):
        with TemporaryDirectory() as folder:
            args = SimpleNamespace(agent=['fixture'], cwd=folder, agent_name='dsh',
                                   permission='workspace', session='', terminal=False)
            acp = bridge.AcpBridge([], folder, 'dsh', 'workspace')

            def request(method, _params):
                if method == 'initialize':
                    return {'protocolVersion': 1}
                if method == 'session/new':
                    return {'sessionId': 'output-limit-session'}
                self.assertEqual(method, 'session/prompt')
                return {'stopReason': 'max_tokens'}

            output = io.StringIO()
            with patch.object(bridge, '_parse', return_value=args), \
                    patch.object(bridge, '_utf8_stdio'), \
                    patch.object(bridge, 'AcpBridge', return_value=acp), \
                    patch.object(bridge.sys, 'stdin', io.StringIO('synthetic')), \
                    patch.object(bridge.sys, 'stdout', output), \
                    patch.object(acp, 'start'), patch.object(acp, 'request', side_effect=request), \
                    patch.object(acp.access, 'apply'), patch.object(acp, 'close', wraps=acp.close) as close:
                self.assertEqual(bridge.main(), 2)
            events = [json.loads(line) for line in output.getvalue().splitlines()]
            self.assertFalse(any(event.get('error') for event in events))
            self.assertEqual([event['part']['reason'] for event in events
                              if event.get('type') == 'step_finish'], ['max_tokens', 'max_tokens'])
            close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
