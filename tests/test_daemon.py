import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from dispatcher.runtime import terminate

ROOT = Path(__file__).resolve().parents[1]


class Daemon(unittest.TestCase):
    def test_stop_releases_single_instance_and_terminates_owned_watcher(self):
        with tempfile.TemporaryDirectory() as root:
            database = str(Path(root, 't.db'))
            child_pid = Path(root, 'child.pid')
            code = ("import os,time,json,pathlib,datetime as d; "
                    "pathlib.Path(%r).write_text(str(os.getpid())); "
                    "print(json.dumps({'source':'fixture','checkpoint':d.datetime.now(d.timezone.utc).isoformat()}),flush=True); "
                    "time.sleep(60)" % str(child_pid))
            cfg = {'db': {'path': database}, 'watchers': [{'source': 'fixture', 'command': ['{python}', '-c', code]}],
                   'start': {'lookback_minutes': 0}, 'windows': {}, 'opencode': {'url': 'http://127.0.0.1:1', 'password': ''}}
            command = [sys.executable, '-c', 'import json,sys; from dispatcher.__main__ import run; run(json.loads(sys.argv[1]))',
                       json.dumps(cfg)]
            log = Path(root, 'log.txt')
            with log.open('w+', encoding='utf-8') as output:
                process = subprocess.Popen(command, cwd=ROOT, stdout=output, stderr=output)
                try:
                    deadline = time.monotonic() + 15
                    while not child_pid.exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.05)
                    self.assertTrue(child_pid.exists(), log.read_text(encoding='utf-8'))
                    duplicate = subprocess.run(command, cwd=ROOT, capture_output=True, timeout=10)
                    self.assertNotEqual(duplicate.returncode, 0)
                    self.assertIn(b'already running', duplicate.stderr)
                    Path(database + '.stop').touch()
                    self.assertEqual(process.wait(timeout=20), 0, log.read_text(encoding='utf-8'))
                    if os.name == 'nt':
                        result = subprocess.run(['tasklist', '/FI', 'PID eq ' + child_pid.read_text(), '/FO', 'CSV', '/NH'],
                                                capture_output=True, timeout=10)
                        self.assertNotIn(('"' + child_pid.read_text() + '"').encode(), result.stdout)
                finally:
                    terminate(process)


if __name__ == '__main__':
    unittest.main()
