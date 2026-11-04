import contextlib
import io
import os
import tempfile
import unittest
from unittest import mock

from dispatcher import __main__ as app, work
from dispatcher.db import connect, now
from dispatcher.opencode import Opencode
from test_pipeline import line, REPLY


class Recovery(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg = {'db': {'path': os.path.join(self.tmp.name, 't.db')},
                    'opencode': {'url': 'http://unused', 'password': ''}}
        self.db = connect(self.cfg['db']['path'])
        app.ingest(self.db, line())
        with self.db:
            self.wid = self.db.execute(
                "INSERT INTO work_item (title, session_id, created_at, last_activity_at) VALUES ('Test','ses_1',?,?)",
                (now(), now())).lastrowid
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,1,'attach',?)", (self.wid, now()))
        self.batch, _ = work.take_batch(self.db, 1)
        with self.db:
            self.db.execute('UPDATE batch SET work_item=?, prompt_id=?, delivered_at=? WHERE id=?',
                            (self.wid, 'msg_1', now(), self.batch))

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_collecting_same_draft_twice_keeps_it_pending(self):
        with self.db:
            work.store_draft(self.db, self.wid, 1, self.batch, 'Reply')
            work.store_draft(self.db, self.wid, 1, self.batch, 'Reply')
        self.assertEqual([tuple(r) for r in self.db.execute('SELECT text,status FROM draft')], [('Reply', 'pending')])

    def test_own_reply_during_turn_drops_the_new_draft(self):
        app.ingest(self.db, line(message_id='mine', sender_is_me=True))
        with self.db:
            work.store_draft(self.db, self.wid, 1, self.batch, 'Already answered')
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'dropped')

    def test_failed_turn_cannot_leave_an_approvable_draft(self):
        with mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'failed')):
            work.collect(self.cfg, self.db, self.batch)
        self.assertEqual(self.db.execute("SELECT COUNT(*) FROM draft WHERE status='pending'").fetchone()[0], 0)

    def test_retry_delivered_batch_collects_without_resending_prompt(self):
        with self.db:
            self.db.execute("UPDATE batch SET state='failed' WHERE id=?", (self.batch,))
        with mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')), \
                mock.patch.object(Opencode, 'prompt') as prompt, contextlib.redirect_stdout(io.StringIO()):
            app.retry(self.cfg, self.batch)
        prompt.assert_not_called()
        self.assertEqual(self.db.execute('SELECT batch FROM message').fetchone()[0], self.batch)
        self.assertEqual(self.db.execute('SELECT state FROM batch').fetchone()[0], 'done')

    def test_running_conversation_cannot_be_claimed_twice(self):
        app.ingest(self.db, line(message_id='next'))
        batch, messages = work.take_batch(self.db, 1)
        self.assertIsNone(batch)
        self.assertEqual(messages, [])
        self.assertIsNone(self.db.execute("SELECT batch FROM message WHERE message_id='next'").fetchone()[0])

    def test_turn_does_not_collect_text_from_a_later_user_turn(self):
        messages = [
            {'type': 'idle', 'id': 'idle_2', 'outcome': 'succeeded'},
            {'type': 'assistant', 'id': 'a2', 'content': [{'type': 'text', 'text': 'Later reply'}]},
            {'type': 'user', 'id': 'msg_2'},
            {'type': 'idle', 'id': 'idle_1', 'outcome': 'succeeded'},
            {'type': 'assistant', 'id': 'a1', 'content': [{'type': 'text', 'text': 'First reply'}]},
            {'type': 'user', 'id': 'msg_1'},
        ]
        oc = Opencode('http://unused', '')
        with mock.patch.object(oc, 'call', return_value={'data': messages, 'cursor': {}}):
            self.assertEqual(oc.turn('ses_1', 'msg_1'), ('First reply', 'succeeded'))


if __name__ == '__main__':
    unittest.main()
