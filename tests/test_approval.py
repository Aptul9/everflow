import datetime as dt
import os
import tempfile
import unittest
import urllib.parse
from unittest import mock

from dispatcher import __main__ as app, work
from dispatcher.db import connect, now
from test_pipeline import line


class Approval(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = connect(os.path.join(self.tmp.name, 'approval.db'))
        app.ingest(self.db, line())
        with self.db:
            self.wid = self.db.execute("INSERT INTO work_item (title,session_id,created_at,last_activity_at) "
                                       "VALUES ('Task','ses_1',?,?)", (now(), now())).lastrowid
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,1,'attach',?)", (self.wid, now()))
        self.batch, _ = work.take_batch(self.db, 1)
        with self.db:
            work.store_draft(self.db, self.wid, 1, self.batch, 'Exact approved text')
            self.db.execute("UPDATE batch SET state='done',work_item=? WHERE id=?", (self.wid, self.batch))
        self.did = self.db.execute('SELECT id FROM draft').fetchone()[0]

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def shown(self):
        from dispatcher import approval
        return approval.present(self.db, self.did, 'session', 'ses_1', 'msg_draft', at='2026-11-04T00:00:00Z')

    def answer(self, text='ok', **values):
        from dispatcher import approval
        event = dict(channel='session', target='ses_1', event_id='user_1', text=text, actor_is_me=True,
                     at=now())
        event.update(values)
        return approval.decide(self.db, self.did, **event)

    def test_approval_is_bound_to_displayed_text_and_target(self):
        shown = self.shown()
        self.assertEqual(shown['text'], 'Exact approved text')
        self.assertEqual(shown['account'], 'me@roarinc.com')
        self.assertEqual(shown['native_id'], 'C1')
        self.assertEqual(self.answer(), 'approved')
        self.assertEqual(self.answer(), 'duplicate')

    def test_other_author_or_session_cannot_approve(self):
        self.shown()
        self.assertEqual(self.answer(actor_is_me=False), 'rejected')
        self.assertEqual(self.answer(target='ses_other', event_id='user_2'), 'rejected')
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'pending')

    def test_edit_after_presentation_invalidates_approval(self):
        self.shown()
        with self.db:
            self.db.execute("UPDATE draft SET text='Changed text' WHERE id=?", (self.did,))
        self.assertEqual(self.answer(), 'stale')

    def test_new_message_invalidates_previously_approved_draft(self):
        self.shown()
        self.assertEqual(self.answer(), 'approved')
        app.ingest(self.db, line(message_id='new'))
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'stale')

    def test_revision_is_recorded_without_treating_it_as_approval(self):
        self.shown()
        self.assertEqual(self.answer('Make it shorter'), 'revision_requested')
        row = self.db.execute('SELECT action,body,state FROM approval_event').fetchone()
        self.assertEqual(tuple(row), ('revise', 'Make it shorter', 'pending'))

    def test_shadow_gate_never_calls_reader_or_sender(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        reader, sender = mock.Mock(), mock.Mock()
        self.assertEqual(approval.deliver({'delivery': {'enabled': False}}, self.db, self.did, reader, sender), 'shadow')
        reader.assert_not_called()
        sender.assert_not_called()

    def test_send_time_reread_blocks_new_incoming_message(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        reader = mock.Mock(return_value={'complete': True, 'messages': [line(message_id='late')]})
        sender = mock.Mock()
        result = approval.deliver({'mode': {'shadow': False}, 'delivery': {'enabled': True}}, self.db, self.did, reader, sender)
        self.assertEqual(result, 'stale')
        sender.assert_not_called()

    def test_send_time_reread_invalidates_edited_known_message(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        original = self.db.execute('SELECT native_id AS message_id,sent_at FROM message').fetchone()
        edited = line(message_id=original['message_id'], sent_at=original['sent_at'], text='Cancel this change')
        reader = mock.Mock(return_value={'complete': True, 'messages': [edited]})
        sender = mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'stale')
        sender.assert_not_called()
        stored = self.db.execute('SELECT text,batch FROM message').fetchall()
        self.assertEqual([tuple(r) for r in stored], [('Cancel this change', None)])
        self.assertFalse(app.ingest(self.db, edited))

    def test_unchanged_known_message_does_not_invalidate_consent(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        original = self.db.execute('SELECT native_id AS message_id,sent_at FROM message').fetchone()
        reader = mock.Mock(return_value={'complete': True, 'messages': [
            line(message_id=original['message_id'], sent_at=original['sent_at'])]})
        sender = mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'sent')
        sender.assert_called_once()

    def test_other_account_copy_cannot_hide_send_time_cancellation(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        app.ingest(self.db, line(account='other@roarinc.com', message_id='shared-message', text='Other account copy'))
        reader = mock.Mock(return_value={'complete': True, 'messages': [
            line(message_id='shared-message', text='Cancel this change')]})
        sender = mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'stale')
        sender.assert_not_called()

    def test_successful_send_is_once_and_uses_exact_text(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        reader = mock.Mock(return_value={'complete': True, 'messages': []})
        sender = mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'sent')
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'sent')
        self.assertEqual(sender.call_count, 1)
        self.assertEqual(sender.call_args.args[1], 'Exact approved text')

    def test_ambiguous_send_failure_is_never_automatically_repeated(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        reader = mock.Mock(return_value={'complete': True, 'messages': []})
        sender = mock.Mock(side_effect=TimeoutError('lost response'))
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'uncertain')
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'uncertain')
        self.assertEqual(sender.call_count, 1)

    def test_user_message_before_presentation_is_not_consent(self):
        self.shown()
        self.assertEqual(self.answer(at='2026-11-03T23:59:59Z'), 'rejected')

    def test_local_cli_review_cannot_approve_live_delivery(self):
        from dispatcher import approval
        approval.present(self.db, self.did, 'local', 'operator', 'local-review')
        result = self.answer(channel='local', target='operator')
        self.assertEqual(result, 'rejected')
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'pending')

    def test_legacy_local_consent_never_reaches_transports(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        with self.db:
            self.db.execute("UPDATE approval_event SET channel='local',target='operator'")
        reader, sender = mock.Mock(return_value={'complete': True, 'messages': []}), mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'blocked')
        reader.assert_not_called()
        sender.assert_not_called()

    def test_default_presentation_preserves_subsecond_boundary(self):
        from dispatcher import approval
        fixed = dt.datetime(2026, 11, 4, 11, 0, 0, 900000, tzinfo=dt.timezone.utc)
        with mock.patch('dispatcher.db.dt.datetime') as clock:
            clock.now.return_value = fixed
            approval.present(self.db, self.did, 'session', 'ses_1', 'msg_draft')
        self.assertEqual(self.answer(at='2026-11-04T11:00:00.100000Z'), 'rejected')

    def test_poll_requires_an_actual_completed_draft_message(self):
        from dispatcher import approval
        with self.db:
            self.db.execute("UPDATE batch SET prompt_id='msg_source',created_at='2026-11-04T10:00:00Z'")
        client = mock.Mock()
        client.call.return_value = {'data': [
            {'id': 'msg_old_ok', 'type': 'user', 'text': 'ok', 'time': {'created': 1793790000100}},
            {'id': 'msg_source', 'type': 'user', 'text': '[inbox-dispatcher] source',
             'time': {'created': 1793786400000}}], 'cursor': {}}
        with mock.patch.object(approval, 'now', return_value='2026-11-04T11:00:00Z'):
            approval.poll_sessions({'approval': {'enabled': True}}, self.db, client)
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'pending')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM approval_request').fetchone()[0], 0)

    def test_poll_binds_real_completed_assistant_anchor(self):
        from dispatcher import approval
        with self.db:
            self.db.execute("UPDATE batch SET prompt_id='msg_source',created_at='2026-11-04T10:00:00Z'")
        client = mock.Mock()
        messages = [
            {'id': 'msg_ok', 'type': 'user', 'text': 'ok', 'time': {'created': 1793790001000}},
            {'id': 'msg_idle', 'type': 'idle', 'outcome': 'succeeded', 'time': {'created': 1793790000950}},
            {'id': 'msg_output', 'type': 'assistant', 'time': {'created': 1793790000100, 'completed': 1793790000900},
             'content': [{'type': 'text', 'text': '<<<DRAFT conversation=1\nExact approved text\nDRAFT>>>'}]},
            {'id': 'msg_source', 'type': 'user', 'text': '[inbox-dispatcher] source',
             'time': {'created': 1793786400000}}]
        client.call.side_effect = [{'data': messages[:2], 'cursor': {'next': 'older'}},
                                   {'data': messages[2:], 'cursor': {}}]
        with mock.patch.object(approval, 'now', return_value='2026-11-04T11:00:00Z'):
            approval.poll_sessions({'approval': {'enabled': True}}, self.db, client)
        proof = self.db.execute('SELECT anchor,shown_at FROM approval_request').fetchone()
        self.assertEqual(tuple(proof), ('msg_output', '2026-11-04T11:00:00.900000Z'))
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'approved')
        query = urllib.parse.parse_qs(urllib.parse.urlparse(client.call.call_args_list[1].args[1]).query)
        self.assertIn('cursor', query)
        self.assertNotIn('order', query)

    def test_legacy_synthetic_session_anchor_cannot_authorize_send(self):
        from dispatcher import approval
        self.shown()
        self.answer()
        with self.db:
            self.db.execute("UPDATE approval_request SET anchor='draft:1'")
        reader, sender = mock.Mock(return_value={'complete': True, 'messages': []}), mock.Mock(return_value='sent_id')
        settings = {'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        self.assertEqual(approval.deliver(settings, self.db, self.did, reader, sender), 'blocked')
        reader.assert_not_called()
        sender.assert_not_called()

    def test_direct_revision_paging_reaches_prompt_older_than_batch_creation(self):
        from dispatcher import approval
        with self.db:
            self.db.execute("UPDATE batch SET prompt_id='msg_revision',created_at='2026-11-04T11:01:00Z'")
        first = [
            {'id': 'msg_ok', 'type': 'user', 'text': 'ok', 'time': {'created': 1793790180000}},
            {'id': 'msg_idle', 'type': 'idle', 'outcome': 'succeeded', 'time': {'created': 1793790120600}},
            {'id': 'msg_output', 'type': 'assistant', 'time': {'created': 1793790120100, 'completed': 1793790120500},
             'content': [{'type': 'text', 'text': '<<<DRAFT conversation=1\nExact approved text\nDRAFT>>>'}]},
        ] + [{'id': 'msg_earlier_%d' % i, 'type': 'assistant', 'content': [],
              'time': {'created': 1793790001000 + i * 1000, 'completed': 1793790001010 + i * 1000}}
             for i in reversed(range(47))]
        client = mock.Mock()
        client.call.side_effect = [
            {'data': first, 'cursor': {'next': 'revision-source'}},
            {'data': [{'id': 'msg_revision', 'type': 'user', 'text': 'Make it shorter',
                       'time': {'created': 1793790000000}}], 'cursor': {}},
        ]
        approval.poll_sessions({'approval': {'enabled': True}}, self.db, client)
        self.assertEqual(client.call.call_count, 2)
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'approved')
        self.assertEqual(self.db.execute('SELECT anchor FROM approval_request').fetchone()[0], 'msg_output')

    def test_bare_ok_is_ambiguous_with_multiple_shown_drafts(self):
        from dispatcher import approval
        self.shown()
        app.ingest(self.db, line(message_id='other', conversation_id='C2'))
        batch, _ = work.take_batch(self.db, 2)
        with self.db:
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,2,'attach',?)", (self.wid, now()))
            work.store_draft(self.db, self.wid, 2, batch, 'Other draft')
        approval.present(self.db, 2, 'session', 'ses_1', 'anchor_2', at='2026-11-04T00:00:00Z')
        self.assertEqual(approval.control(self.db, 'session', 'ses_1', 'user_1', 'ok', True, now()), 'ambiguous')
        self.assertEqual(approval.control(self.db, 'session', 'ses_1', 'user_2', 'ok 2', True, now()), 'approved')

    def test_disabled_session_observer_makes_no_api_calls(self):
        from dispatcher import approval
        client = mock.Mock()
        approval.poll_sessions({'approval': {'enabled': False}}, self.db, client)
        client.call.assert_not_called()

    def test_notes_control_requires_own_message_in_configured_self_chat(self):
        from dispatcher import approval
        approval.present(self.db, self.did, 'notes', 'me@roarinc.com/48:notes', 'notice',
                         at='2026-11-04T00:00:00Z')
        config = {'approval': {'enabled': True, 'notes_account': 'me@roarinc.com'}}
        incoming = line(source='teams', account='me@roarinc.com', conversation_id='48:notes',
                        message_id='reply', text='ok', sender_is_me=False, sent_at=now())
        self.assertFalse(approval.notes_control(config, self.db, incoming))
        incoming['sender_is_me'] = True
        self.assertTrue(approval.notes_control(config, self.db, incoming))
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'approved')

    def test_revision_is_collected_from_same_session_without_another_prompt(self):
        from dispatcher import approval
        from dispatcher.opencode import Opencode
        self.shown()
        self.answer('Shorter please')
        event = self.db.execute('SELECT id FROM approval_event').fetchone()[0]
        text = '<<<DRAFT conversation=1\nShort reply\nDRAFT>>>\nSTATUS: revised'
        settings = {'db': {'path': self.db.execute('PRAGMA database_list').fetchone()[2]},
                    'opencode': {'url': 'http://unused', 'password': ''}}
        with mock.patch.object(Opencode, 'prompt') as prompt, \
                mock.patch.object(Opencode, 'turn', return_value=(text, 'succeeded')):
            approval.revise(settings, self.db, event)
        prompt.assert_not_called()
        self.assertEqual([tuple(r) for r in self.db.execute('SELECT text,status FROM draft ORDER BY id')],
                         [('Exact approved text', 'superseded'), ('Short reply', 'pending')])

    def test_revision_rereads_original_source_context_before_send(self):
        from dispatcher import approval, channels, watch_outlook
        from dispatcher.db import parse
        from dispatcher.opencode import Opencode
        with self.db:
            self.db.execute("UPDATE message SET sent_at='2026-11-04T10:00:00Z'")
        self.shown()
        self.answer('Shorter please')
        event = self.db.execute('SELECT id FROM approval_event').fetchone()[0]
        settings = {'opencode': {'url': 'http://unused', 'password': ''},
                    'mode': {'shadow': False}, 'delivery': {'enabled': True}}
        replacement = '<<<DRAFT conversation=1\nShort reply\nDRAFT>>>\nSTATUS: revised'
        with mock.patch.object(Opencode, 'turn', return_value=(replacement, 'succeeded')):
            approval.revise(settings, self.db, event)
        with self.db:
            self.db.execute("UPDATE draft SET created_at='2026-11-04T10:06:00Z' WHERE id=2")
        approval.present(self.db, 2, 'session', 'ses_1', 'msg_revised', at='2026-11-04T10:07:00Z')
        approval.decide(self.db, 2, channel='session', target='ses_1', event_id='msg_ok_revision', text='ok',
                        actor_is_me=True, at='2026-11-04T10:08:00Z')
        late = line(message_id='unseen_before_revision', sent_at='2026-11-04T10:04:00Z', text='Cancel this change')
        item = mock.Mock(Class=43, ConversationID='C1')
        inbox, sent = mock.Mock(), mock.Mock()
        inbox.Items.Restrict.side_effect = lambda since: [item] if parse(since) <= parse(late['sent_at']) else []
        sent.Items.Restrict.return_value = []
        account = mock.Mock(SmtpAddress='me@roarinc.com')
        account.DeliveryStore.GetDefaultFolder.side_effect = lambda kind: inbox if kind == watch_outlook.INBOX else sent
        namespace = mock.Mock(Accounts=[account])
        sender = mock.Mock(return_value='sent_id')
        with mock.patch.object(channels, '_outlook', return_value=namespace), \
                mock.patch.object(watch_outlook, 'since_filter', side_effect=lambda sent, since: since.isoformat()), \
                mock.patch.object(watch_outlook, 'record', return_value=late):
            result = approval.deliver(settings, self.db, 2, lambda d: channels.read(settings, self.db, d), sender)
        self.assertEqual(result, 'stale')
        sender.assert_not_called()


if __name__ == '__main__':
    unittest.main()
