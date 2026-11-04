import datetime as dt
import unittest
from unittest import mock

from dispatcher import __main__ as app, watch_teamsrelay
from dispatcher.db import connect


class RelayReplay(unittest.TestCase):
    def test_late_saved_message_survives_restart_after_list_scan(self):
        db = connect(':memory:')
        floor = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)).replace(microsecond=0)
        with db:
            db.execute("INSERT INTO cursor VALUES ('teamsrelay','*',?)", (app.iso(floor),))
        account = {'slot': 1, 'email': 'me@example.com', 'scan_at': int(floor.timestamp()) + 600, 'messages': []}
        relay = mock.Mock()
        relay.snapshot.return_value = {'accounts': [account], 'errors': []}
        cfg = {'start': {'lookback_minutes': 0}}
        try:
            watch_teamsrelay.watch_round(relay, floor, {}, lambda row: app.ingest(db, row))
            resumed = app.watcher_start(cfg, db, 'teamsrelay')
            account['messages'].append({'chat': 'A', 'id': 'late', 'time': app.iso(floor + dt.timedelta(minutes=2)),
                                         'author': 'Bob', 'text': 'Saved after the list scan'})
            watch_teamsrelay.watch_round(relay, resumed, {}, lambda row: app.ingest(db, row))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM message').fetchone()[0], 1)
            self.assertEqual(app.watcher_start(cfg, db, 'teamsrelay'), floor)
            watch_teamsrelay.watch_round(relay, floor, {}, lambda row: app.ingest(db, row))
            self.assertEqual(db.execute('SELECT COUNT(*) FROM message').fetchone()[0], 1)
        finally:
            db.close()

    def test_saved_message_edit_is_emitted_during_same_process(self):
        floor = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=1)
        account = {'slot': 1, 'email': 'me@example.com', 'scan_at': int(floor.timestamp()) + 600, 'messages': [
            {'chat': 'A', 'id': '1', 'time': app.iso(floor + dt.timedelta(minutes=2)), 'author': 'Bob', 'text': 'Original'}]}
        relay = mock.Mock()
        relay.snapshot.return_value = {'accounts': [account], 'errors': []}
        records, state = [], {}
        watch_teamsrelay.watch_round(relay, floor, state, records.append)
        account['messages'][0]['text'] = 'Cancelled'
        watch_teamsrelay.watch_round(relay, floor, state, records.append)
        self.assertEqual([r['text'] for r in records if 'message_id' in r], ['Original', 'Cancelled'])


if __name__ == '__main__':
    unittest.main()
