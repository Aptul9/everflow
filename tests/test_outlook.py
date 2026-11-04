import contextlib
import io
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
        self.assertEqual(self.scan([self.account, failed]), '')
        self.assertEqual(self.state['since'], self.since)

    def test_failed_item_holds_checkpoint(self):
        item = mock.Mock(Class=43)
        self.account.DeliveryStore.GetDefaultFolder.return_value.Items.Restrict.return_value = [item]
        with mock.patch.object(outlook, 'record', side_effect=outlook.pythoncom.com_error(-1, 'unreadable', None, None)):
            self.assertEqual(self.scan([self.account]), '')
        self.assertEqual(self.state['since'], self.since)

    def test_missing_known_account_holds_checkpoint(self):
        self.state['accounts'] = {'a@example.com', 'b@example.com'}
        self.assertEqual(self.scan([self.account]), '')
        self.assertEqual(self.state['since'], self.since)

    def test_complete_scan_reports_all_covered_accounts(self):
        import json
        records = [json.loads(s) for s in self.scan([self.account]).splitlines()]
        self.assertEqual(records[-1].get('accounts'), ['a@example.com'])
        self.assertIn('checkpoint', records[-1])


if __name__ == '__main__':
    unittest.main()
