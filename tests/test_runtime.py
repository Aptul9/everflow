import datetime as dt
import os
import queue
import tempfile
import threading
import unittest
from unittest import mock

from dispatcher import __main__ as app
from dispatcher.db import connect


class Runtime(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, 'runtime.db')
        self.db = connect(self.path)
        self.cfg = {'db': {'path': self.path}, 'start': {'lookback_minutes': 0}}

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_empty_source_keeps_first_start_across_restart(self):
        first = app.watcher_start(self.cfg, self.db, 'outlook')
        with self.db:
            self.db.execute("UPDATE cursor SET since='2026-11-04T18:00:00Z' WHERE source='outlook'")
        resumed = app.watcher_start(self.cfg, self.db, 'outlook')
        self.assertLess(resumed, first)
        self.assertEqual(resumed, dt.datetime(2026, 11, 4, 18, tzinfo=dt.timezone.utc))

    def test_checkpoint_advances_only_its_source_without_creating_a_message(self):
        app.watcher_start(self.cfg, self.db, 'teams')
        checkpoint = app.iso(dt.datetime.now(dt.timezone.utc))
        self.assertTrue(app.ingest(self.db, {'source': 'teams', 'checkpoint': checkpoint, 'accounts': ['me@example.com']}))
        self.assertEqual(self.db.execute("SELECT since FROM cursor WHERE source='teams' AND account='*'").fetchone()[0],
                         checkpoint)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM message').fetchone()[0], 0)

    def test_single_instance_lock_is_released_on_exit(self):
        with app.instance_lock(self.path):
            with self.assertRaises(RuntimeError):
                with app.instance_lock(self.path):
                    self.fail('second daemon acquired lock')
        with app.instance_lock(self.path):
            pass

    def test_invalid_line_cannot_move_a_checkpoint(self):
        with self.assertRaises(ValueError):
            app.ingest(self.db, {'source': 'teams', 'checkpoint': '2099-01-01T00:00:00Z'})
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM cursor').fetchone()[0], 0)

    def test_teams_restart_retains_oldest_known_account_cursor(self):
        current = dt.datetime.now(dt.timezone.utc)
        older, newer = app.iso(current - dt.timedelta(hours=1)), app.iso(current - dt.timedelta(minutes=1))
        with self.db:
            self.db.executemany('INSERT INTO cursor VALUES (?,?,?)',
                                [('teams', '*', newer), ('teams', 'a@example.com', newer),
                                 ('teams', 'b@example.com', older)])
        self.assertEqual(app.watcher_start(self.cfg, self.db, 'teams'), dt.datetime.fromisoformat(older.replace('Z', '+00:00')))

    def test_teams_inventory_survives_database_reopen(self):
        app.watcher_start(self.cfg, self.db, 'teams')
        self.assertTrue(app.ingest(self.db, {'source': 'teams', 'accounts': ['a@example.com', 'b@example.com']}))
        self.db.close()
        self.db = connect(self.path)
        self.assertEqual([r[0] for r in self.db.execute("SELECT account FROM cursor WHERE source='teams' AND account!='*' ORDER BY account")],
                         ['a@example.com', 'b@example.com'])
        with self.assertRaises(ValueError):
            app.ingest(self.db, {'source': 'teams', 'checkpoint': app.iso(dt.datetime.now(dt.timezone.utc)),
                                'accounts': ['a@example.com']})

    def test_complete_teams_checkpoint_advances_quiet_accounts(self):
        old = app.iso(dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1))
        with self.db:
            self.db.executemany('INSERT INTO cursor VALUES (?,?,?)',
                                [('teams', '*', old), ('teams', 'a@example.com', old), ('teams', 'b@example.com', old)])
        stamp = app.iso(dt.datetime.now(dt.timezone.utc))
        app.ingest(self.db, {'source': 'teams', 'checkpoint': stamp, 'accounts': ['a@example.com', 'b@example.com']})
        self.assertEqual({r[0] for r in self.db.execute("SELECT since FROM cursor WHERE source='teams'")}, {stamp})

    def test_teams_watcher_receives_persisted_account_coverage(self):
        stamp = app.iso(dt.datetime.now(dt.timezone.utc))
        with self.db:
            self.db.executemany('INSERT INTO cursor VALUES (?,?,?)',
                                [('teams', '*', stamp), ('teams', 'a@example.com', stamp), ('teams', 'b@example.com', stamp)])
        stop = threading.Event()
        child = mock.Mock(stdout=[])

        def start(*args, **kwargs):
            stop.set()
            return child

        with mock.patch.object(app.subprocess, 'Popen', side_effect=start) as popen, \
                mock.patch.object(app, 'terminate'):
            app.watcher(self.cfg, {'source': 'teams', 'command': ['{python}', 'watch.py']}, queue.Queue(), stop, {})
        self.assertEqual(popen.call_args.args[0][-4:],
                         ['--expected-account', 'a@example.com', '--expected-account', 'b@example.com'])


if __name__ == '__main__':
    unittest.main()
