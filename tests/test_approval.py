import datetime as dt
import os
import tempfile
import unittest
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
        return approval.present(self.db, self.did, 'session', 'ses_1', 'anchor', at='2026-11-04T00:00:00Z')

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


if __name__ == '__main__':
    unittest.main()
