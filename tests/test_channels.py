import unittest
import urllib.parse
from unittest import mock


class Channels(unittest.TestCase):
    def test_shadow_mode_refuses_even_if_delivery_switch_is_true(self):
        from dispatcher import channels
        with mock.patch.object(channels, 'teams') as teams:
            with self.assertRaises(RuntimeError):
                channels.send({'mode': {'shadow': True}, 'delivery': {'enabled': True}}, None,
                              {'source': 'teams'}, 'No send', 'key')
        teams.assert_not_called()

    def test_live_teams_send_uses_approved_account_chat_and_text(self):
        from dispatcher import channels
        module = mock.Mock()
        module.remote.return_value.send_message.return_value = {'status': 201, 'clientmessageid': 'client_1'}
        with mock.patch.object(channels, 'teams', return_value=module):
            result = channels.send({'mode': {'shadow': False}, 'delivery': {'enabled': True}}, None,
                                   {'source': 'teams', 'account': 'me@example.com', 'native_id': 'chat_1'},
                                   'Exact text', 'key')
        self.assertEqual(result, 'client_1')
        module.remote.return_value.send_message.assert_called_once_with(
            {'account': 'me@example.com', 'id': 'chat_1'}, text='Exact text')

    def test_relay_send_is_held_without_a_live_source_reread(self):
        from dispatcher import channels
        with self.assertRaises(RuntimeError):
            channels.read({}, None, {'source': 'teamsrelay'})

    def test_missing_source_context_holds_delivery(self):
        from dispatcher import channels
        from dispatcher.db import connect, now
        db = connect(':memory:')
        try:
            with mock.patch.object(channels, '_outlook', return_value=mock.Mock(Accounts=[])), \
                    self.assertRaisesRegex(RuntimeError, 'source context'):
                channels.read({}, db, {'source': 'outlook', 'conversation': 1, 'batch': 1,
                                       'account': 'me@example.com', 'created_at': now()})
        finally:
            db.close()

    def test_teams_reread_keeps_deleted_source_context(self):
        from dispatcher import __main__ as app, channels
        from dispatcher.db import connect, parse
        from test_pipeline import line
        db = connect(':memory:')
        original = line(source='teams', account='me@example.com', conversation_id='chat_1',
                        message_id='chat_1;messageid=1', attachments=[])
        app.ingest(db, original)
        module = mock.Mock()
        module.urllib.parse = urllib.parse
        module.WATCH_SKIP_TYPES = ('ThreadActivity', 'Control/', 'Event/')
        module.remote.return_value.SERVER = 'https://teams.example.com'
        module.remote.return_value._account.return_value = {'region': 'emea', 'ic3': 'fixture'}
        module.remote.return_value._jwt.return_value = {'oid': 'me'}
        module.remote.return_value.iso_ms.return_value = int(parse(original['sent_at']).timestamp() * 1000)
        module._pages.return_value = [{'id': '1', 'messagetype': 'RichText/Html',
                                      'originalarrivaltime': original['sent_at'],
                                      'properties': {'deletetime': original['sent_at']}}]
        module._sender_oid.return_value = 'bob'
        try:
            with mock.patch.object(channels, 'teams', return_value=module):
                result = channels.read({}, db, {'source': 'teams', 'conversation': 1, 'native_id': 'chat_1',
                                               'account': 'me@example.com', 'title': 'Chat'})
            self.assertEqual(len(result['messages']), 1)
            self.assertTrue(result['messages'][0]['ref']['deleted'])
            self.assertEqual(result['messages'][0]['text'], '')
        finally:
            db.close()


if __name__ == '__main__':
    unittest.main()
