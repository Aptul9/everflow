import contextlib
import io
import json
import unittest
from unittest import mock

from dispatcher import watch_outlook as outlook


class OutlookCoverage(unittest.TestCase):
    def setUp(self):
        self.since = outlook.parse_iso('2026-11-04T10:00:00Z')
        self.state = {'since': self.since}
        self.account = mock.Mock(SmtpAddress='a@example.com')
        self.account.DeliveryStore.StoreID = 'store_a'
        self.account.DeliveryStore.GetDefaultFolder.return_value.Items.Restrict.return_value = []

    def scan(self, accounts):
        output = io.StringIO()
        app = mock.Mock()
        app.GetNamespace.return_value.Accounts = accounts
        with mock.patch.object(outlook.win32com.client, 'GetActiveObject', return_value=app), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            try:
                outlook.watch(self.state, 0, True, set())
            except (outlook.pythoncom.com_error, RuntimeError):
                pass
        return output.getvalue()

    def test_unavailable_account_folder_holds_checkpoint(self):
        failed = mock.Mock(SmtpAddress='b@example.com')
        failed.DeliveryStore.GetDefaultFolder.side_effect = outlook.pythoncom.com_error(-1, 'offline', None, None)
        self.assertFalse(any('checkpoint' in json.loads(s) for s in self.scan([self.account, failed]).splitlines()))
        self.assertEqual(self.state['since'], self.since)

    def test_failed_item_holds_checkpoint(self):
        item = mock.Mock(Class=43)
        self.account.DeliveryStore.GetDefaultFolder.return_value.Items.Restrict.return_value = [item]
        with mock.patch.object(outlook, 'record', side_effect=outlook.pythoncom.com_error(-1, 'unreadable', None, None)):
            self.assertFalse(any('checkpoint' in json.loads(s) for s in self.scan([self.account]).splitlines()))
        self.assertEqual(self.state['since'], self.since)

    def test_missing_known_account_holds_checkpoint(self):
        self.state['accounts'] = {'a@example.com', 'b@example.com'}
        self.assertFalse(any('checkpoint' in json.loads(s) for s in self.scan([self.account]).splitlines()))
        self.assertEqual(self.state['since'], self.since)

    def test_complete_scan_reports_all_covered_accounts(self):
        records = [json.loads(s) for s in self.scan([self.account]).splitlines()]
        self.assertEqual(records[-1].get('accounts'), ['a@example.com'])
        self.assertIn('checkpoint', records[-1])

    def test_failed_account_discovery_is_durable_before_folder_reads(self):
        from dispatcher import __main__ as app
        from dispatcher.db import connect
        db = connect(':memory:')
        with db:
            db.execute("INSERT INTO cursor VALUES ('outlook','*',?)", (outlook.iso(self.since),))
        failed = mock.Mock(SmtpAddress='b@example.com')
        failed.DeliveryStore.GetDefaultFolder.side_effect = outlook.pythoncom.com_error(-1, 'offline', None, None)
        try:
            for line in self.scan([self.account, failed]).splitlines():
                app.ingest(db, json.loads(line))
            accounts = {r[0] for r in db.execute("SELECT account FROM cursor WHERE source='outlook' AND account!='*'")}
            self.assertEqual(accounts, {'a@example.com', 'b@example.com'})
            self.state = {'since': self.since, 'accounts': accounts}
            restarted = [json.loads(line) for line in self.scan([self.account]).splitlines()]
            self.assertFalse(any('checkpoint' in row for row in restarted))
            with self.assertRaises(ValueError):
                app.ingest(db, {'source': 'outlook', 'accounts': ['a@example.com'],
                                'checkpoint': outlook.iso(self.since)})
        finally:
            db.close()

    def test_seen_message_identity_includes_receiving_account(self):
        output, seen = io.StringIO(), set()
        item = mock.Mock(Class=43)
        with mock.patch.object(outlook, 'record', side_effect=lambda item, account, mine, sent:
                               {'message_id': 'shared', 'account': account}), contextlib.redirect_stdout(output):
            outlook.emit(item, 'a@example.com', set(), False, seen)
            outlook.emit(item, 'b@example.com', set(), False, seen)
        self.assertEqual(len(output.getvalue().splitlines()), 2)

    def test_native_event_is_logged_separately_from_restrict_scan(self):
        with mock.patch.object(outlook.Events, 'pending', []), mock.patch.object(outlook, 'log') as log:
            outlook.Events().OnNewMailEx('E1,,E2')
            self.assertEqual(outlook.Events.pending, ['E1', 'E2'])
            log.assert_called_once_with('NewMailEx received 2 item(s)')


if __name__ == '__main__':
    unittest.main()
