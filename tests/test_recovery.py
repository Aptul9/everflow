import contextlib
import io
import os
import tempfile
import unittest
from unittest import mock

from dispatcher import __main__ as app, work
from dispatcher.db import connect, now
from dispatcher.opencode import Opencode
from test_pipeline import ago, line, REPLY


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
        self.assertIsNone(self.db.execute("SELECT batch FROM message WHERE native_id='next'").fetchone()[0])

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

    def uncertain_submission(self):
        with self.db:
            self.db.execute("UPDATE batch SET state='failed',delivered_at=NULL WHERE id=?", (self.batch,))
            self.db.execute('INSERT INTO prompt_submission VALUES (?,?,?,?,?,?,?)',
                            (self.batch, 'ses_1', 'msg_1', 'Original task', 'uncertain', now(), 'response lost'))

    def test_recovery_reserves_batch_before_deferred_collector_starts(self):
        self.uncertain_submission()
        app.ingest(self.db, line(message_id='cancellation', text='Cancel original task'))
        with mock.patch.object(work.threading, 'Thread'):
            self.assertEqual(work.recover(self.cfg, self.db), [self.batch])
        self.assertEqual(self.db.execute('SELECT state FROM batch WHERE id=?', (self.batch,)).fetchone()[0], 'running')
        self.assertEqual(work.take_batch(self.db, 1), (None, []))
        self.assertEqual(app.due(dict(self.cfg, windows={'outlook': 300}), self.db), [])

    def test_uncertain_submission_blocks_new_batch_before_restart(self):
        self.uncertain_submission()
        app.ingest(self.db, line(message_id='cancellation', text='Cancel original task'))
        self.assertEqual(work.take_batch(self.db, 1), (None, []))

    def test_linked_conversation_waits_for_uncertain_work_item(self):
        self.uncertain_submission()
        app.ingest(self.db, line(message_id='linked_cancel', conversation_id='C2', text='Cancel original task'))
        with self.db:
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,2,'attach',?)", (self.wid, now()))
        self.assertEqual(work.take_batch(self.db, 2), (None, []))

    def test_already_claimed_linked_conversation_defers_until_reconciliation(self):
        app.ingest(self.db, line(message_id='linked_cancel', conversation_id='C2', text='Cancel original task'))
        later, messages = work.take_batch(self.db, 2)
        with self.db:
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,2,'attach',?)", (self.wid, now()))
        self.uncertain_submission()
        with mock.patch.object(Opencode, 'prompt', side_effect=lambda s, t, prompt_id=None, **kw: prompt_id) as prompt, \
                mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')):
            work.deliver(self.cfg, self.db, work._row(self.db, 'work_item', self.wid),
                         work._row(self.db, 'conversation', 2), later, messages, [])
        prompt.assert_not_called()
        self.assertEqual(self.db.execute('SELECT state FROM batch WHERE id=?', (later,)).fetchone()[0], 'deferred')
        self.assertIsNone(self.db.execute('SELECT batch FROM message WHERE conversation=2').fetchone()[0])

    def test_uncertain_submission_prevents_idle_archiving(self):
        self.uncertain_submission()
        with self.db:
            self.db.execute('UPDATE work_item SET last_activity_at=? WHERE id=?', (ago(90000), self.wid))
        with mock.patch.object(Opencode, 'archive') as archive:
            work.archive_idle(self.cfg, self.db)
        archive.assert_not_called()

    def test_failed_cli_collection_can_be_retried_without_stranding_running_batch(self):
        with self.db:
            self.db.execute("UPDATE batch SET state='failed' WHERE id=?", (self.batch,))
        app.ingest(self.db, line(message_id='next_after_failure'))
        with mock.patch.object(Opencode, 'turn', side_effect=TimeoutError('transient read failure')):
            with self.assertRaises(TimeoutError):
                app.retry(self.cfg, self.batch)
        row = self.db.execute('SELECT state,error FROM batch WHERE id=?', (self.batch,)).fetchone()
        self.assertEqual(row['state'], 'failed')
        self.assertIn('TimeoutError', row['error'])
        self.assertEqual(app.due(dict(self.cfg, windows={'outlook': 300}), self.db), [1])
        with mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')), \
                mock.patch.object(Opencode, 'prompt') as prompt, contextlib.redirect_stdout(io.StringIO()):
            app.retry(self.cfg, self.batch)
        prompt.assert_not_called()
        self.assertEqual(self.db.execute('SELECT state FROM batch WHERE id=?', (self.batch,)).fetchone()[0], 'done')

    def legacy_second_submission(self):
        app.ingest(self.db, line(message_id='legacy_later', conversation_id='C2', text='Later cancellation'))
        with self.db:
            self.db.execute("INSERT INTO work_item_conversation VALUES (?,2,'attach',?)", (self.wid, now()))
            later = self.db.execute("INSERT INTO batch(conversation,work_item,state,prompt_id,created_at) "
                                    "VALUES (2,?,'failed','msg_later',?)", (self.wid, now())).lastrowid
            self.db.execute('UPDATE message SET batch=? WHERE conversation=2', (later,))
            self.db.execute('INSERT INTO prompt_submission VALUES (?,?,?,?,?,?,?)',
                            (later, 'ses_1', 'msg_later', 'Later cancellation', 'uncertain', now(), 'response lost'))
        return later

    def test_multiple_legacy_submissions_recover_in_order_with_deferred_threads(self):
        self.uncertain_submission()
        later = self.legacy_second_submission()
        scheduled, admitted, accepted = [], [], set()

        class Deferred:
            def __init__(self, target, args, **kwargs):
                scheduled.append((target, args))

            def start(self):
                pass

        def accept(session, text, prompt_id=None, **kwargs):
            admitted.append(text)
            accepted.add(prompt_id)
            return prompt_id

        with mock.patch.object(work.threading, 'Thread', Deferred), \
                mock.patch.object(Opencode, 'turn', side_effect=lambda s, p: (REPLY, 'succeeded') if p in accepted else None), \
                mock.patch.object(Opencode, 'queued', return_value=[]), mock.patch.object(Opencode, 'prompt', side_effect=accept):
            self.assertEqual(work.recover(self.cfg, self.db), [self.batch, later])
            for target, args in reversed(scheduled):
                target(*args)
        self.assertEqual(admitted, ['Original task', 'Later cancellation'])

    def test_manual_reconciliation_cannot_overtake_earlier_uncertain_input(self):
        self.uncertain_submission()
        later = self.legacy_second_submission()
        with mock.patch.object(Opencode, 'turn', return_value=('', 'succeeded')), \
                mock.patch.object(Opencode, 'prompt') as prompt, self.assertRaisesRegex(RuntimeError, 'earlier'):
            work.resume_batch(self.cfg, self.db, later)
        prompt.assert_not_called()

    def test_older_collection_preserves_newer_valid_draft_and_status(self):
        with self.db:
            self.db.execute("UPDATE batch SET state='failed' WHERE id=?", (self.batch,))
        app.ingest(self.db, line(message_id='newer_input', text='Updated instructions'))
        newer, _ = work.take_batch(self.db, 1)
        with self.db:
            self.db.execute("UPDATE batch SET work_item=?,state='done',prompt_id='msg_newer',delivered_at=?,done_at=? WHERE id=?",
                            (self.wid, now(), now(), newer))
            work.store_draft(self.db, self.wid, 1, newer, 'Current valid reply')
            self.db.execute("UPDATE work_item SET status_line='Current completed work' WHERE id=?", (self.wid,))
        with mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')), \
                mock.patch.object(Opencode, 'prompt') as prompt, contextlib.redirect_stdout(io.StringIO()):
            app.retry(self.cfg, self.batch)
        prompt.assert_not_called()
        with self.subTest('draft recency'):
            self.assertEqual([tuple(r) for r in self.db.execute('SELECT text,status FROM draft ORDER BY id')],
                             [('Current valid reply', 'pending'), ('Hi Bob, done.', 'stale')])
        with self.subTest('status recency'):
            self.assertEqual(self.db.execute('SELECT status_line FROM work_item WHERE id=?', (self.wid,)).fetchone()[0],
                             'Current completed work')


if __name__ == '__main__':
    unittest.main()
