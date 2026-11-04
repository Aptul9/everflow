import datetime as dt
import http.server
import io
import json
import os
import tempfile
import threading
import unittest
import urllib.error
from unittest import mock

from dispatcher import __main__ as app, config, triage, vault, watch_teamsrelay, work
from dispatcher.db import connect, now
from dispatcher.opencode import Opencode


def ago(seconds):
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=seconds)).strftime('%Y-%m-%dT%H:%M:%SZ')


def line(**kw):
    m = {'source': 'outlook', 'account': 'me@roarinc.com', 'conversation_id': 'C1', 'conversation_title': 'Deploy',
         'message_id': '<1@x>', 'sender': 'Bob@roarinc.com', 'sender_name': 'Bob', 'sender_is_me': False,
         'sent_at': ago(600), 'text': 'Can you check RCA-12 today?', 'attachments': [{'name': 'a.log', 'size': 3}],
         'ref': {'entry_id': 'E1'}}
    m.update(kw)
    return m


REPLY = 'Checked.\n<<<DRAFT conversation=1\nHi Bob, done.\nDRAFT>>>\nSTATUS: RCA-12 checked, reply drafted'


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.tmp.name, '01_Projects'))
        with open(os.path.join(self.tmp.name, '01_Projects', 'roar-k8s.md'), 'w', encoding='utf-8') as f:
            f.write('---\nstatus: active\ntags: [project/roar-k8s]\n---\n\n# Roar AKS\n\n## Status\nUpgrade running.\n')
        self.cfg = {'db': {'path': os.path.join(self.tmp.name, 't.db')}, 'windows': {'outlook': 300},
                    'triage': {'min_confidence': 0.75}, 'vault': {'path': self.tmp.name},
                    'clients': {'roar': {'accounts': ['me@roarinc.com'], 'keywords': ['roar']},
                                'msc': {'domains': ['msccruises.com'], 'keywords': ['msc']}},
                    'opencode': {'url': 'http://127.0.0.1:1', 'password': 'p', 'directory': self.tmp.name}}
        self.db = connect(self.cfg['db']['path'])

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def work_item(self, keys=()):
        with self.db:
            wid = self.db.execute("INSERT INTO work_item (title, client, keys, created_at, last_activity_at) "
                                  "VALUES ('Old', 'roar', ?, ?, ?)", (json.dumps(list(keys)), now(), now())).lastrowid
        return wid

    def test_dedupe_moves_cursor_after_store(self):
        self.assertTrue(app.ingest(self.db, line()))
        self.assertFalse(app.ingest(self.db, line()))
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM message').fetchone()[0], 1)
        self.assertEqual(self.db.execute('SELECT since FROM cursor').fetchone()[0], line()['sent_at'])
        self.assertEqual(self.db.execute('SELECT email FROM person').fetchone()[0], 'bob@roarinc.com')

    def test_due_waits_for_quiet_window_and_ignores_own_messages(self):
        app.ingest(self.db, line(message_id='<me>', sender_is_me=True, sent_at=ago(900)))
        self.assertEqual(app.due(self.cfg, self.db), [])
        app.ingest(self.db, line(message_id='<2>', sent_at=ago(100)))
        self.assertEqual(app.due(self.cfg, self.db), [])
        app.ingest(self.db, line(message_id='<3>', conversation_id='C2', sent_at=ago(400)))
        self.assertEqual(len(app.due(self.cfg, self.db)), 1)

    def test_conversation_answered_by_me_closes_without_a_run(self):
        app.ingest(self.db, line(message_id='<q>', sent_at=ago(700)))
        app.ingest(self.db, line(message_id='<a>', sender_is_me=True, sent_at=ago(400)))
        self.assertEqual(app.due(self.cfg, self.db), [])
        batch = self.db.execute('SELECT id, state FROM batch').fetchone()
        self.assertEqual(batch['state'], 'answered')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM message WHERE batch=?', (batch['id'],)).fetchone()[0], 2)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM triage_log').fetchone()[0], 0)

    def test_new_message_marks_draft_stale_and_own_reply_drops_it(self):
        app.ingest(self.db, line())
        wid = self.work_item()
        with self.db:
            self.db.execute("INSERT INTO draft (work_item, conversation, text, idempotency_key, created_at, updated_at) "
                            "VALUES (?, 1, 'x', 'k', ?, ?)", (wid, now(), now()))
        app.ingest(self.db, line(message_id='<2>'))
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'stale')
        app.ingest(self.db, line(message_id='<3>', sender_is_me=True))
        self.assertEqual(self.db.execute('SELECT status FROM draft').fetchone()[0], 'dropped')

    def test_triage_parse(self):
        ok = triage.parse('```json\n{"relevant": true, "assigned_to_me": true, "action": "attach", '
                          '"work_item": "wi:1", "reason": "same deploy", "confidence": 1.4}\n```', ['wi:1'])
        self.assertEqual((ok['action'], ok['work_item'], ok['confidence']), ('attach', 'wi:1', 1.0))
        self.assertIsNone(triage.parse('{"action": "start", "work_item": "wi:9"}', ['wi:1'])['work_item'])
        with self.assertRaises(ValueError):
            triage.parse('{"action": "send"}', [])

    def test_triage_moves_to_next_plan_on_rate_limit(self):
        def limited(code):
            return urllib.error.HTTPError('u', code, 'x', {}, io.BytesIO(b'{"type":"error"}'))
        cfg = {'triage': {'model': 'm', 'routes': [{'provider': 'a'}, {'provider': 'b'}]}}
        with mock.patch.object(triage, '_post', side_effect=[limited(429), '{"ok": 1}']) as post:
            self.assertEqual(triage.ask(cfg, 'x'), '{"ok": 1}')
        self.assertEqual([c[0][0]['provider'] for c in post.call_args_list], ['a', 'b'])
        with mock.patch.object(triage, '_post', side_effect=[limited(400)]), self.assertRaises(RuntimeError):
            triage.ask(cfg, 'x')

    def test_keys_skip_encodings(self):
        self.assertEqual(work.keys('RCA-12, UTF-8, ISO-8601, https://github.com/a/b/pull/3 x'),
                         {'RCA-12', 'https://github.com/a/b/pull/3'})

    def test_clients_from_account_then_domains(self):
        self.assertEqual(config.clients_for(self.cfg, 'ME@roarinc.com', []), ['roar'])
        self.assertEqual(config.clients_for(self.cfg, 'me@bandpey.com', ['x@msccruises.com']), ['msc'])
        self.assertEqual(config.clients_for(self.cfg, 'me@bandpey.com', ['x@gmail.com']), [])
        # relay senders are names: the receiving account's domain names the client
        cfg = dict(self.cfg, clients=dict(self.cfg['clients'], npo={'domains': ['nposervices.com']}))
        self.assertEqual(config.clients_for(cfg, 'me@nposervices.com', ['mario rossi']), ['npo'])

    def test_vault_cards_reach_area_subfolders(self):
        for rel, head in [('02_Areas/msc/msc.md', ''), ('02_Areas/msc/tickets/concierge.md', 'status: active'),
                          ('02_Areas/msc/tickets/_closed/old.md', ''), ('02_Areas/msc/tickets/done.md', 'status: closed')]:
            path = os.path.join(self.tmp.name, *rel.split('/'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write('---\n%s\n---\n\n# t\n' % head)
        self.assertEqual(vault.client_notes(self.tmp.name, ['msc']),
                         ['02_Areas/msc/msc.md', '02_Areas/msc/tickets/concierge.md'])

    def test_correlate(self):
        app.ingest(self.db, line())
        conv = work._row(self.db, 'conversation', 1)
        old = self.work_item(keys=['RCA-12'])
        t = {'action': 'start', 'work_item': None, 'confidence': 0.9}
        self.assertEqual(work.correlate(self.cfg, self.db, conv, ['roar'], t, {'RCA-12'})[0]['id'], old)
        t = {'action': 'attach', 'work_item': 'wi:%d' % old, 'confidence': 0.5}
        new, soft = work.correlate(self.cfg, self.db, conv, ['roar'], t, set())
        self.assertNotEqual(new['id'], old)
        self.assertEqual([s['id'] for s in soft], [old])
        kinds = dict(self.db.execute('SELECT work_item, kind FROM work_item_conversation').fetchall())
        self.assertEqual(kinds[new['id']], 'attach')
        t = {'action': 'start', 'work_item': 'note:01_Projects/roar-k8s.md', 'confidence': 0.3}
        guessed = work.correlate(self.cfg, self.db, conv, ['roar'], t, set())[0]
        self.assertEqual((guessed['vault_note'], guessed['note_guess']), (None, '01_Projects/roar-k8s.md'))
        self.assertIn('triage guessed 01_Projects/roar-k8s.md', work.first_prompt(guessed, conv, [], []))

    def test_draft_needs_linked_target_and_goes_stale(self):
        app.ingest(self.db, line())
        wid = self.work_item()
        batch, _ = work.take_batch(self.db, 1)
        with self.db:
            work.store_draft(self.db, wid, 1, batch, 'unlinked')
            self.db.execute("INSERT INTO work_item_conversation VALUES (?, 1, 'attach', ?)", (wid, now()))
            work.store_draft(self.db, wid, 1, batch, 'first')
            work.store_draft(self.db, wid, 1, batch, 'second')
        app.ingest(self.db, line(message_id='<late>'))
        with self.db:
            work.store_draft(self.db, wid, 1, batch, 'third')
        rows = self.db.execute('SELECT text, status FROM draft ORDER BY id').fetchall()
        self.assertEqual([tuple(r) for r in rows], [('unlinked', 'no_target'), ('first', 'superseded'),
                                                    ('second', 'stale'), ('third', 'stale')])

    def test_draft_named_by_native_id(self):
        app.ingest(self.db, line())
        wid = self.work_item()
        batch, _ = work.take_batch(self.db, 1)
        reply = 'x\n<<<DRAFT conversation=C1\nHello\nDRAFT>>>\n<<<DRAFT conversation=7\nLost\nDRAFT>>>\nSTATUS: s'
        with self.db:
            self.db.execute("INSERT INTO work_item_conversation VALUES (?, 1, 'attach', ?)", (wid, now()))
            for target, body in work.DRAFT_RX.findall(reply):
                work.store_draft(self.db, wid, target, batch, body)
        rows = self.db.execute('SELECT text, conversation, status FROM draft ORDER BY id').fetchall()
        self.assertEqual([tuple(r) for r in rows], [('Hello', 1, 'pending'), ('Lost', None, 'no_target')])
        self.assertIn('Local time now: ', work.next_prompt(work._row(self.db, 'conversation', 1), [], []))

    def test_relay_watch_reads_new_then_only_changed_chats(self):
        since = watch_teamsrelay.parse_iso('2026-11-04T10:00:00Z')
        chats = {'A': [{'id': '1', 'time': '2026-11-04T09:00:00.000Z', 'author': 'Bob', 'text': 'old'},
                       {'id': '2', 'time': '2026-11-04T11:00:00.000Z', 'author': 'Bob', 'text': 'new'}],
                 'B': [{'id': '3', 'time': '2026-11-01T09:00:00.000Z', 'author': 'Eve', 'text': 'x'}]}
        rows = {'A': ('11:00', 'new'), 'B': ('11/1', 'x')}
        reads = []

        class Fake:
            def tool(self, name, args):
                if name == 'list_accounts':
                    return {'accounts': [{'slot': 2, 'email': 'Me@MSCcruises.com'}, {'slot': 9, 'stopped': True}]}
                if name == 'list_chats':
                    return {'chats': [{'name': n, 'last': rows[n][0], 'preview': rows[n][1]} for n in chats]}
                reads.append(args['chat'])
                return {'messages': chats[args['chat']]}

        out, state = [], {'rows': {}, 'recheck': {}, 'seen': set()}
        watch_teamsrelay.watch_round(Fake(), since, state, out.append)
        self.assertEqual([(r['message_id'], r['account'], r['sent_at']) for r in out],
                         [('me@msccruises.com/A;messageid=2', 'me@msccruises.com', '2026-11-04T11:00:00.000Z')])
        reads.clear()
        watch_teamsrelay.watch_round(Fake(), since, state, out.append)
        self.assertEqual(reads, [])  # no list row changed: no chat read
        chats['B'].append({'id': '4', 'time': '2026-11-04T12:00:00.000Z', 'author': 'Eve', 'text': 'hi'})
        rows['B'] = ('12:00', 'hi')
        watch_teamsrelay.watch_round(Fake(), since, state, out.append)
        self.assertEqual((reads, out[-1]['text'], len(out)), (['B'], 'hi', 2))

    def test_turn_collects_text_after_prompt(self):
        pages = [{'data': [{'type': 'idle', 'id': 'i', 'outcome': 'succeeded'},
                           {'type': 'assistant', 'id': 'a2', 'content': [{'type': 'text', 'text': 'two'}]},
                           {'type': 'assistant', 'id': 'a1', 'content': [{'type': 'tool'}, {'type': 'text', 'text': 'one'}]}],
                  'cursor': {'next': 'c'}},
                 {'data': [{'type': 'user', 'id': 'msg_p'}, {'type': 'assistant', 'id': 'old'}], 'cursor': {}}]
        oc = Opencode('http://x', 'p')
        with mock.patch.object(oc, 'call', side_effect=pages):
            self.assertEqual(oc.turn('ses', 'msg_p'), ('one\ntwo', 'succeeded'))
        with mock.patch.object(oc, 'call', return_value={'data': [{'type': 'user', 'id': 'other'}], 'cursor': {}}):
            self.assertIsNone(oc.turn('ses', 'msg_p'))

    def test_openchamber_cookie_and_sign_in_again(self):
        signs = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length'])).decode()
                signs.append(body)
                self.send_response(200 if body == 'password=s%26cret' else 401)
                self.send_header('Set-Cookie', 'oc_ui_session=t%d; Path=/; HttpOnly' % len(signs))
                self.end_headers()
                self.wfile.write(b'{"authenticated":true}')

            def do_GET(self):
                ok = self.headers.get('Cookie') == 'oc_ui_session=t2'  # the first cookie counts as expired
                self.send_response(200 if ok else 401)
                self.end_headers()
                self.wfile.write(b'{"data": {}}' if ok else b'{}')

        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            oc = Opencode('http://127.0.0.1:%d' % server.server_port, 's&cret', openchamber=True)
            self.assertEqual(oc.call('GET', '/api/session/active'), {'data': {}})
            self.assertEqual(len(signs), 2)
        finally:
            server.shutdown()
            server.server_close()

    def test_run_start_to_draft(self):
        app.ingest(self.db, line())
        answer = '{"relevant": true, "assigned_to_me": true, "action": "start", ' \
                 '"work_item": "note:01_Projects/roar-k8s.md", "reason": "asks a check", "confidence": 0.9}'
        prompts = []
        with mock.patch.object(triage, 'ask', return_value=answer) as ask, \
                mock.patch.object(Opencode, 'create', return_value='ses_1') as create, \
                mock.patch.object(Opencode, 'prompt', side_effect=lambda s, t: prompts.append(t) or 'msg_1'), \
                mock.patch.object(Opencode, 'turn', return_value=(REPLY, 'succeeded')):
            work.run(self.cfg, 1)
        self.assertIn('note:01_Projects/roar-k8s.md', ask.call_args[0][1])
        self.assertEqual(create.call_args[0][0], 'Outlook: Deploy')
        self.assertIn('Vault note: 01_Projects/roar-k8s.md', prompts[0])
        self.assertIn('read_email entry_id=E1', prompts[0])
        w = work._row(self.db, 'work_item', 1)
        self.assertEqual((w['session_id'], w['status_line'], w['keys']), ('ses_1', 'RCA-12 checked, reply drafted',
                                                                          '["RCA-12"]'))
        self.assertEqual(tuple(self.db.execute('SELECT text, status FROM draft').fetchone()), ('Hi Bob, done.', 'pending'))
        self.assertEqual(self.db.execute('SELECT state FROM batch').fetchone()[0], 'done')
        # The next batch on the same conversation skips triage and goes to the same session as the next turn,
        # which waits in the inbox, runs, then ends.
        app.ingest(self.db, line(message_id='<2>', text='Thanks'))
        turns = [None, ('', None), ('ok\nSTATUS: closed', 'succeeded')]
        with mock.patch.object(triage, 'ask') as ask, \
                mock.patch.object(Opencode, 'prompt', side_effect=lambda s, t: prompts.append(t) or 'msg_2'), \
                mock.patch.object(Opencode, 'queued', return_value=['msg_2']), \
                mock.patch.object(Opencode, 'turn', side_effect=turns) as turn, \
                mock.patch.object(work, 'POLL_SECONDS', 0):
            work.run(self.cfg, 1)
        ask.assert_not_called()
        self.assertEqual(turn.call_count, 3)
        self.assertIn('New messages for this work item', prompts[1])
        self.assertEqual(work._row(self.db, 'work_item', 1)['status_line'], 'closed')

    def test_ignore_stops_at_the_gate(self):
        app.ingest(self.db, line(text='Newsletter'))
        answer = '{"relevant": false, "assigned_to_me": false, "action": "ignore", "work_item": null, ' \
                 '"reason": "newsletter", "confidence": 0.95}'
        with mock.patch.object(triage, 'ask', return_value=answer), mock.patch.object(Opencode, 'create') as create:
            work.run(self.cfg, 1)
        create.assert_not_called()
        self.assertEqual(self.db.execute('SELECT state FROM batch').fetchone()[0], 'ignore')
        self.assertEqual(self.db.execute('SELECT reason FROM triage_log').fetchone()[0], 'newsletter')


if __name__ == '__main__':
    unittest.main()
