import unittest
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


if __name__ == '__main__':
    unittest.main()
