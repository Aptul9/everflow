import argparse
import datetime as dt
import json
import logging
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import config, work
from .db import connect, now, parse

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ('source', 'account', 'conversation_id', 'message_id', 'sender_is_me', 'sent_at')
MAX_CATCH_UP = dt.timedelta(days=7)
log = logging.getLogger('dispatcher')


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def ingest(db, m):
    """Store one watcher line. Returns False for a message already stored."""
    if any(k not in m for k in REQUIRED):
        log.warning('watcher line without %s', [k for k in REQUIRED if k not in m])
        return False
    sent_at = iso(parse(m['sent_at']).astimezone(dt.timezone.utc))
    sender = (m.get('sender') or '').lower()
    with db:
        db.execute('INSERT INTO conversation (source, account, native_id, title, last_message_at) VALUES (?,?,?,?,?) '
                   "ON CONFLICT (source, account, native_id) DO UPDATE SET "
                   "title=COALESCE(NULLIF(excluded.title, ''), title), "
                   "last_message_at=MAX(COALESCE(last_message_at, ''), excluded.last_message_at)",
                   (m['source'], m['account'], m['conversation_id'], m.get('conversation_title'), sent_at))
        conv = db.execute('SELECT id FROM conversation WHERE source=? AND account=? AND native_id=?',
                          (m['source'], m['account'], m['conversation_id'])).fetchone()[0]
        person = None
        column = 'email' if '@' in sender else {'teams': 'teams_oid', 'gchat': 'gchat_id'}.get(m['source'])
        if sender and column:
            db.execute('INSERT INTO person (%s, name) VALUES (?, ?) ON CONFLICT (%s) DO UPDATE SET '
                       'name=COALESCE(excluded.name, name)' % (column, column), (sender, m.get('sender_name') or None))
            person = db.execute('SELECT id FROM person WHERE %s=?' % column, (sender,)).fetchone()[0]
        stored = db.execute(
            'INSERT OR IGNORE INTO message (source, message_id, conversation, person, sender, sender_name, '
            'sender_is_me, sent_at, text, attachments, ref, stored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            (m['source'], m['message_id'], conv, person, sender, m.get('sender_name'), bool(m['sender_is_me']),
             sent_at, m.get('text'), json.dumps(m.get('attachments') or []), json.dumps(m.get('ref') or {}),
             now())).rowcount
        if not stored:
            return False
        # The cursor moves in the same transaction as the store, never before it.
        db.execute('INSERT INTO cursor (source, account, since) VALUES (?,?,?) ON CONFLICT (source, account) '
                   'DO UPDATE SET since=MAX(since, excluded.since)', (m['source'], m['account'], sent_at))
        if m['sender_is_me']:  # Antonio answered himself: the pending draft is moot
            db.execute("UPDATE draft SET status='dropped', updated_at=? WHERE conversation=? "
                       "AND status IN ('pending', 'stale')", (now(), conv))
        else:
            db.execute("UPDATE draft SET status='stale', updated_at=? WHERE conversation=? AND status='pending'",
                       (now(), conv))
    return True


def due(cfg, db):
    """Conversations with a pending message from someone else, quiet for their window, and no run going."""
    rows = db.execute(
        "SELECT c.id, c.source, MAX(m.sent_at) AS last FROM conversation c JOIN message m ON m.conversation=c.id "
        "WHERE m.batch IS NULL AND NOT EXISTS (SELECT 1 FROM batch b WHERE b.conversation=c.id "
        "AND b.state='running') GROUP BY c.id HAVING SUM(1 - m.sender_is_me) > 0").fetchall()
    current = parse(now())
    return [r['id'] for r in rows
            if (current - parse(r['last'])).total_seconds() >= cfg['windows'].get(r['source'], 300)]


def watcher(cfg, spec, lines):
    db = connect(cfg['db']['path'])
    while True:
        oldest = db.execute('SELECT MIN(since) FROM cursor WHERE source=?', (spec['source'],)).fetchone()[0]
        floor = dt.datetime.now(dt.timezone.utc) - MAX_CATCH_UP
        start = max(parse(oldest), floor) if oldest else (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=cfg['start']['lookback_minutes']))
        command = [sys.executable if c == '{python}' else c for c in spec['command']] + ['--since', iso(start)]
        log.info('%s watcher starting from %s', spec['source'], iso(start))
        p = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, text=True, encoding='utf-8',
                             errors='replace')
        for line in p.stdout:
            if line.strip():
                lines.put(line)
        log.warning('%s watcher exited with code %s, restarting in 30 s', spec['source'], p.wait())
        time.sleep(30)


def run(cfg):
    db = connect(cfg['db']['path'])
    resumed = work.recover(cfg, db)
    if resumed:
        log.info('collecting replies of batches delivered before the restart: %s', resumed)
    lines = queue.Queue()
    for spec in cfg['watchers']:
        threading.Thread(target=watcher, args=(cfg, spec, lines), daemon=True, name='watch-' + spec['source']).start()
    runs, archived_at = {}, 0
    while True:
        try:
            while True:
                line = lines.get(timeout=1)
                try:
                    ingest(db, json.loads(line))
                except (ValueError, KeyError) as e:
                    log.warning('bad watcher line (%s): %.200s', e, line)
        except queue.Empty:
            pass
        for conversation in due(cfg, db):
            if conversation in runs and runs[conversation].is_alive():
                continue
            runs[conversation] = threading.Thread(target=work.run, args=(cfg, conversation), daemon=True)
            runs[conversation].start()
        if time.time() - archived_at > 600:
            archived_at = time.time()
            work.archive_idle(cfg, db)


def status(cfg, limit):
    db = connect(cfg['db']['path'])
    for table, column in (('batch', 'state'), ('work_item', 'status'), ('draft', 'status')):
        counts = db.execute('SELECT %s, COUNT(*) FROM %s GROUP BY 1' % (column, table)).fetchall()
        print('%-10s %s' % (table, ', '.join('%s %d' % (r[0], r[1]) for r in counts) or '-'))
    print('cursors    ' + ', '.join('%s/%s %s' % tuple(r) for r in db.execute('SELECT * FROM cursor')))
    print('\ntriage, newest first:')
    for r in db.execute('SELECT t.at, t.action, t.confidence, t.work_item, t.reason, c.source, c.title FROM triage_log t '
                        'JOIN conversation c ON c.id=t.conversation ORDER BY t.id DESC LIMIT ?', (limit,)):
        print('  %s %-6s %.2f %-28s %s | %.60s' % (r['at'], r['action'], r['confidence'] or 0, r['work_item'] or '-',
                                                    r['reason'], r['title'] or ''))
    print('\nwork items:')
    for w in db.execute("SELECT * FROM work_item WHERE status!='closed' ORDER BY last_activity_at DESC LIMIT ?",
                        (limit,)):
        print('  #%d [%s] %.60s | %s | %s' % (w['id'], w['status'], w['title'], w['session_id'] or 'no session',
                                              w['status_line'] or '-'))
    print('\ndrafts:')
    for d in db.execute("SELECT * FROM draft WHERE status IN ('pending', 'stale', 'no_target') ORDER BY id DESC"):
        print('  draft %d [%s] work item %d, conversation %s: %.80s' % (
            d['id'], d['status'], d['work_item'], d['conversation'], d['text'].replace('\n', ' ')))
    print('\nfailed batches:')
    for b in db.execute("SELECT * FROM batch WHERE state='failed' ORDER BY id DESC LIMIT ?", (limit,)):
        print('  batch %d conversation %d: %s' % (b['id'], b['conversation'], b['error']))


def retry(cfg, batch):
    db = connect(cfg['db']['path'])
    with db:
        released = db.execute('UPDATE message SET batch=NULL WHERE batch=? AND batch IN '
                              "(SELECT id FROM batch WHERE state IN ('failed', 'interrupted'))", (batch,)).rowcount
        db.execute("UPDATE batch SET state='retried', done_at=? WHERE id=? AND state IN ('failed', 'interrupted')",
                   (now(), batch))
    print('%d message(s) of batch %d back in the queue' % (released, batch))


def main():
    ap = argparse.ArgumentParser(prog='python -m dispatcher')
    ap.add_argument('--config', default=str(ROOT / 'config.toml'))
    sub = ap.add_subparsers(dest='command', required=True)
    sub.add_parser('run', help='watch, triage, correlate and deliver until stopped')
    st = sub.add_parser('status', help='counts, recent triage decisions, work items, drafts')
    st.add_argument('--limit', type=int, default=20)
    rt = sub.add_parser('retry', help='put the messages of a failed batch back in the queue')
    rt.add_argument('batch', type=int)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    cfg = config.load(args.config)
    if args.command == 'run':
        run(cfg)
    elif args.command == 'status':
        status(cfg, args.limit)
    else:
        retry(cfg, args.batch)


if __name__ == '__main__':
    main()
