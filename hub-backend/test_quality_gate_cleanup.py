"""Real owned process-tree cleanup when an offline quality check is interrupted."""
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import quality_gate


class QualityGateCleanupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='soduwork-gate-cleanup-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.marker = self.root / 'owned-child.json'
        self.peer = self.root / 'peer.py'
        self.peer.write_text('''import json,os,signal,socket,sys,time
from pathlib import Path
if os.name != 'nt': signal.signal(signal.SIGTERM,signal.SIG_IGN)
sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen()
Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'port':sock.getsockname()[1]}))
time.sleep(60)
''')
        self.parent = self.root / 'parent.py'
        self.parent.write_text('''import subprocess,sys,time
child=subprocess.Popen([sys.executable,sys.argv[1],sys.argv[2]],
    stdout=None if sys.argv[3]=='inherit' else subprocess.DEVNULL,
    stderr=None if sys.argv[3]=='inherit' else subprocess.DEVNULL,
    start_new_session=sys.argv[3]=='detached')
if sys.argv[3]!='inherit':time.sleep(60)
''')
        self.addCleanup(self.cleanup_fixture)

    def command(self, inherited=False, detached=False):
        python = getattr(sys, '_base_executable', sys.executable)
        return [python, str(self.parent), str(self.peer), str(self.marker),
                'inherit' if inherited else 'detached' if detached else 'discard']

    def child(self):
        return json.loads(self.marker.read_text())

    def cleanup_fixture(self):
        if not self.marker.exists():
            return
        child = self.child()
        if os.name == 'nt':
            subprocess.run(['taskkill', '/PID', str(child['pid']), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        else:
            command = Path(f"/proc/{child['pid']}/cmdline")
            if sys.platform == 'darwin':
                result = subprocess.run(['ps', '-p', str(child['pid']), '-o', 'args='],
                                        text=True, capture_output=True, timeout=3, check=False)
                owned = str(self.peer) in result.stdout
            else:
                owned = command.is_file() and str(self.peer).encode() in command.read_bytes().split(b'\0')
            if owned:
                os.kill(child['pid'], 9)

    def assert_child_stopped(self):
        child = self.child()
        for _ in range(100):
            try:
                connection = socket.create_connection(('127.0.0.1', child['port']), timeout=.1)
            except OSError:
                return
            connection.close()
            time.sleep(.02)
        self.fail('Timed-out check left its owned descendant listening')

    def test_timeout_reaps_a_descendant_that_ignores_graceful_stop(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            quality_gate._run('owned timeout', self.command(), self.root, dict(os.environ), 3)
        self.assert_child_stopped()

    @unittest.skipUnless(sys.platform.startswith('linux') or sys.platform == 'darwin', 'POSIX detached sessions')
    def test_timeout_reaps_a_descendant_in_its_own_session(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            quality_gate._run('detached session', self.command(detached=True), self.root, dict(os.environ), 3)
        self.assert_child_stopped()

    @unittest.skipIf(os.name == 'nt', 'Private POSIX group survives its exited leader')
    def test_timeout_reaps_an_exited_leaders_inherited_pipe_owner(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            quality_gate._run('inherited pipe', self.command(inherited=True), self.root, dict(os.environ), 3)
        self.assert_child_stopped()

    def test_interruption_reaps_the_owned_tree_and_preserves_the_interrupt(self):
        original = subprocess.Popen.communicate
        interrupted = False
        def interrupt(process, *args, **kwargs):
            nonlocal interrupted
            if not interrupted:
                deadline = time.monotonic() + 5
                while not self.marker.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(self.marker.exists(), 'Fixture did not start')
                def reap_parent():
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=3)
                self.addCleanup(reap_parent)
                interrupted = True
                raise KeyboardInterrupt
            return original(process, *args, **kwargs)
        with patch.object(subprocess.Popen, 'communicate', interrupt), self.assertRaises(KeyboardInterrupt):
            quality_gate._run('owned interruption', self.command(), self.root, dict(os.environ), 30)
        self.assert_child_stopped()

    def test_completed_checks_preserve_output_and_failure_status(self):
        with redirect_stdout(io.StringIO()):
            ok, output = quality_gate._run('normal output', [sys.executable, '-c', "print('complete')"],
                                          self.root, dict(os.environ), 5)
            failed, failure = quality_gate._run('failed output',
                [sys.executable, '-c', "print('failed'); raise SystemExit(7)"],
                self.root, dict(os.environ), 5)
        self.assertTrue(ok)
        self.assertEqual(output.strip(), 'complete')
        self.assertFalse(failed)
        self.assertIn('Process exit code: 7', failure)
        self.assertIn('failed', failure)


if __name__ == '__main__':
    unittest.main()
