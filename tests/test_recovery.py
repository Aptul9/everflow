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

    def test_prompt_identity_is_committed_before_network_submission(self):
        with self.db:
            self.db.execute('UPDATE batch SET prompt_id=NULL,delivered_at=NULL WHERE id=?', (self.batch,))

        def accept(session, text, prompt_id=None, **kwargs):
            check = connect(self.cfg['db']['path'])
            try:
                saved = check.execute('SELECT prompt_id,work_item FROM batch WHERE id=?', (self.batch,)).fetchone()
                self.assertIsInstance(prompt_id, str)
                self.assertEqual(tuple(saved), (prompt_id, self.wid))
                submission = check.execute('SELECT prompt_id,text FROM prompt_submission WHERE batch=?', (self.batch,)).fetchone()
                self.assertEqual(tuple(submission), (prompt_id, text))
            finally:
                check.close()
            return prompt_id

        with mock.patch.object(Opencode, 'prompt', side_effect=accept), \
                mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')):
            work.deliver(self.cfg, self.db, work._row(self.db, 'work_item', self.wid),
                         work._row(self.db, 'conversation', 1), self.batch, [], [])

    def test_crash_after_prompt_acceptance_reconciles_without_resubmission(self):
        class ProcessCrash(BaseException):
            pass

        with self.db:
            self.db.execute('UPDATE batch SET prompt_id=NULL,delivered_at=NULL WHERE id=?', (self.batch,))
        accepted = set()

        def crash(session, text, prompt_id=None, **kwargs):
            accepted.add(prompt_id)
            raise ProcessCrash()

        with mock.patch.object(Opencode, 'prompt', side_effect=crash) as prompt, \
                mock.patch.object(Opencode, 'turn', side_effect=lambda s, p: (REPLY, 'succeeded') if p in accepted else None), \
                mock.patch.object(Opencode, 'queued', return_value=[]), mock.patch.object(work.threading, 'Thread'):
            with self.assertRaises(ProcessCrash):
                work.deliver(self.cfg, self.db, work._row(self.db, 'work_item', self.wid),
                             work._row(self.db, 'conversation', 1), self.batch, [], [])
            self.assertEqual(work.recover(self.cfg, self.db), [self.batch])
            self.assertEqual(self.db.execute('SELECT batch FROM message').fetchone()[0], self.batch)
            work.resume_batch(self.cfg, self.db, self.batch)
        self.assertEqual(prompt.call_count, 1)
        self.assertEqual(self.db.execute('SELECT state FROM batch').fetchone()[0], 'done')

    def test_crash_before_prompt_acceptance_reuses_committed_identity(self):
        class ProcessCrash(BaseException):
            pass

        with self.db:
            self.db.execute('UPDATE batch SET prompt_id=NULL,delivered_at=NULL WHERE id=?', (self.batch,))
        with mock.patch.object(Opencode, 'prompt', side_effect=ProcessCrash()) as first, \
                mock.patch.object(work.threading, 'Thread'):
            with self.assertRaises(ProcessCrash):
                work.deliver(self.cfg, self.db, work._row(self.db, 'work_item', self.wid),
                             work._row(self.db, 'conversation', 1), self.batch, [], [])
            self.assertEqual(work.recover(self.cfg, self.db), [self.batch])
        saved = self.db.execute('SELECT prompt_id FROM batch').fetchone()[0]
        self.assertIsInstance(saved, str)
        turns = [None, (REPLY, 'succeeded')]
        with mock.patch.object(Opencode, 'turn', side_effect=turns), \
                mock.patch.object(Opencode, 'queued', return_value=[]), \
                mock.patch.object(Opencode, 'prompt', side_effect=lambda s, t, prompt_id=None, **kw: prompt_id) as retry:
            work.resume_batch(self.cfg, self.db, self.batch)
        self.assertEqual(first.call_args.kwargs['prompt_id'], saved)
        self.assertEqual(retry.call_args.kwargs['prompt_id'], saved)

    def test_revision_prompt_is_recovered_after_acceptance_crash(self):
        from dispatcher import approval

        class ProcessCrash(BaseException):
            pass

        with self.db:
            self.db.execute("UPDATE batch SET state='done' WHERE id=?", (self.batch,))
            work.store_draft(self.db, self.wid, 1, self.batch, 'Original draft')
        approval.present(self.db, 1, 'notes', 'me@roarinc.com/48:notes', 'notice', at='2026-11-04T00:00:00Z')
        approval.decide(self.db, 1, channel='notes', target='me@roarinc.com/48:notes', event_id='notes_revision',
                        text='Make it shorter', actor_is_me=True, at=now())
        event = self.db.execute('SELECT id FROM approval_event').fetchone()[0]
        accepted = set()

        def crash(session, text, prompt_id=None, **kwargs):
            accepted.add(prompt_id)
            raise ProcessCrash()

        with mock.patch.object(Opencode, 'prompt', side_effect=crash) as prompt, \
                mock.patch.object(Opencode, 'turn', side_effect=lambda s, p: (REPLY, 'succeeded') if p in accepted else None), \
                mock.patch.object(Opencode, 'queued', return_value=[]), mock.patch.object(work.threading, 'Thread'):
            with self.assertRaises(ProcessCrash):
                approval.revise(self.cfg, self.db, event)
            batch = self.db.execute('SELECT batch FROM approval_event').fetchone()[0]
            self.assertEqual(work.recover(self.cfg, self.db), [batch])
            work.resume_batch(self.cfg, self.db, batch)
        self.assertEqual(prompt.call_count, 1)
        self.assertEqual(self.db.execute('SELECT state FROM approval_event').fetchone()[0], 'done')
        self.assertEqual(self.db.execute('SELECT status FROM draft ORDER BY id DESC LIMIT 1').fetchone()[0], 'pending')

    def test_timeout_response_reconciles_on_retry_without_resubmission(self):
        with self.db:
            self.db.execute('UPDATE batch SET prompt_id=NULL,delivered_at=NULL WHERE id=?', (self.batch,))
        with mock.patch.object(Opencode, 'prompt', side_effect=TimeoutError('accepted, response lost')):
            with self.assertRaises(TimeoutError):
                work.deliver(self.cfg, self.db, work._row(self.db, 'work_item', self.wid),
                             work._row(self.db, 'conversation', 1), self.batch, [], [])
        work._finish(self.db, self.batch, 'failed', 'response lost')
        with mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')), \
                mock.patch.object(Opencode, 'prompt') as prompt, contextlib.redirect_stdout(io.StringIO()):
            app.retry(self.cfg, self.batch)
        prompt.assert_not_called()
        self.assertEqual(self.db.execute('SELECT state FROM prompt_submission').fetchone()[0], 'admitted')
        self.assertEqual(self.db.execute('SELECT batch FROM message').fetchone()[0], self.batch)

    def test_unknown_legacy_prompt_is_not_requeued(self):
        with self.db:
            self.db.execute("UPDATE batch SET delivered_at=NULL,state='failed' WHERE id=?", (self.batch,))
        with mock.patch.object(Opencode, 'turn', return_value=None), \
                mock.patch.object(Opencode, 'queued', return_value=[]), mock.patch.object(Opencode, 'prompt') as prompt:
            with self.assertRaisesRegex(RuntimeError, 'acceptance unknown'):
                app.retry(self.cfg, self.batch)
        prompt.assert_not_called()
        self.assertEqual(self.db.execute('SELECT batch FROM message').fetchone()[0], self.batch)


if __name__ == '__main__':
    unittest.main()
