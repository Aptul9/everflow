import datetime as dt
import os
import tempfile
import unittest

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
        self.assertTrue(app.ingest(self.db, {'source': 'teams', 'checkpoint': checkpoint}))
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


if __name__ == '__main__':
    unittest.main()
