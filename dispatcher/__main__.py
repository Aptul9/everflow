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

from . import approval, config, work
from .db import connect, message_key, now, parse
from .runtime import instance_lock, terminate

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ('source', 'account', 'conversation_id', 'message_id', 'sender_is_me', 'sent_at')
MAX_CATCH_UP = dt.timedelta(days=7)
log = logging.getLogger('dispatcher')


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def ingest(db, m):
    """Store one watcher line. Returns False for a message already stored."""
    if not isinstance(m, dict):
        raise ValueError('watcher line must be an object')
    covered = m.get('accounts')
    if covered is not None:
        if not isinstance(covered, list) or any(not isinstance(a, str) or not a or a == '*' for a in covered):
            raise ValueError('invalid source account coverage')
        covered = {a.lower() for a in covered}
        if 'checkpoint' not in m:
            floor = db.execute('SELECT MIN(since) FROM cursor WHERE source=?', (m['source'],)).fetchone()[0]
            if not floor:
                raise ValueError('account inventory requires an initial source cursor')
            with db:
                db.executemany('INSERT OR IGNORE INTO cursor VALUES (?,?,?)',
                               [(m['source'], a, floor) for a in sorted(covered)])
            return True
    if 'checkpoint' in m:
        stamp = parse(m['checkpoint'])
        if not m.get('source') or stamp.tzinfo is None or stamp > dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5):
            raise ValueError('invalid source checkpoint')
        with db:
            if m['source'] == 'teams' and not covered:
                raise ValueError('Teams checkpoint requires complete account coverage')
            known = {r[0].lower() for r in db.execute("SELECT account FROM cursor WHERE source=? AND account!='*'",
                                                     (m['source'],))}
            if covered is not None and known - covered:
                raise ValueError('source checkpoint omitted known accounts: ' + ', '.join(sorted(known - covered)))
            db.executemany('INSERT INTO cursor VALUES (?,?,?) ON CONFLICT (source,account) '
                           'DO UPDATE SET since=MAX(since,excluded.since)',
                           [(m['source'], a, iso(stamp)) for a in sorted((covered or set()) | {'*'})])
        return True
    if any(k not in m for k in REQUIRED):
        log.warning('watcher line without %s', [k for k in REQUIRED if k not in m])
        return False
    sent_at = iso(parse(m['sent_at']).astimezone(dt.timezone.utc))
    sender = (m.get('sender') or '').lower()
    identity = message_key(m['account'], m['message_id'])
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
            'INSERT OR IGNORE INTO message (source, message_id, native_id, conversation, person, sender, sender_name, '
            'sender_is_me, sent_at, text, attachments, ref, stored_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (m['source'], identity, m['message_id'], conv, person, sender, m.get('sender_name'), bool(m['sender_is_me']),
             sent_at, m.get('text'), json.dumps(m.get('attachments') or []), json.dumps(m.get('ref') or {}),
              now())).rowcount
        if not stored:
            previous = db.execute('SELECT * FROM message WHERE source=? AND message_id=?',
                                  (m['source'], identity)).fetchone()
            before = (previous['sender'], bool(previous['sender_is_me']), previous['sent_at'], previous['text'] or '',
                      json.loads(previous['attachments'] or '[]'), json.loads(previous['ref'] or '{}').get('deleted', False))
            after = (sender, bool(m['sender_is_me']), sent_at, m.get('text') or '', m.get('attachments') or [],
                     (m.get('ref') or {}).get('deleted', False))
            if previous['conversation'] != conv or before == after:
                return False
            # Source edits retain their native id. Requeue the changed version and invalidate prior drafts.
            db.execute('UPDATE message SET person=?,sender=?,sender_name=?,sender_is_me=?,sent_at=?,text=?, '
                       'attachments=?,ref=?,batch=NULL,stored_at=? WHERE id=?',
                       (person, sender, m.get('sender_name'), bool(m['sender_is_me']), sent_at, m.get('text'),
                        json.dumps(m.get('attachments') or []), json.dumps(m.get('ref') or {}), now(), previous['id']))
        # The cursor moves in the same transaction as the store, never before it.
        db.execute('INSERT INTO cursor (source, account, since) VALUES (?,?,?) ON CONFLICT (source, account) '
                   'DO UPDATE SET since=MAX(since, excluded.since)', (m['source'], m['account'], sent_at))
        if m['sender_is_me']:  # Antonio answered himself: the pending draft is moot
            db.execute("UPDATE draft SET status='dropped', updated_at=? WHERE conversation=? "
                       "AND status IN ('pending', 'approved', 'revision_requested', 'stale')", (now(), conv))
        else:
            db.execute("UPDATE draft SET status='stale', updated_at=? WHERE conversation=? "
                       "AND status IN ('pending','approved','revision_requested')",
                       (now(), conv))
    return True


def due(cfg, db):
    """Conversations quiet for their window with a pending message from someone else, and no run going.

    When the newest pending message is the user's own, the other side has had its answer: those messages close
    as one 'answered' batch, with no triage and no session."""
    rows = db.execute(
        "SELECT c.id, c.source, MAX(m.sent_at) AS last, SUM(1 - m.sender_is_me) AS others, "
        "(SELECT x.sender_is_me FROM message x WHERE x.conversation=c.id AND x.batch IS NULL "
        "ORDER BY x.sent_at DESC, x.id DESC LIMIT 1) AS mine_last "
        "FROM conversation c JOIN message m ON m.conversation=c.id WHERE m.batch IS NULL AND NOT EXISTS "
        "(SELECT 1 FROM batch b WHERE b.conversation=c.id AND b.state='running') GROUP BY c.id").fetchall()
    current, out = parse(now()), []
    for r in rows:
        if work.busy(db, r['id']):
            continue
        if (current - parse(r['last'])).total_seconds() < cfg['windows'].get(r['source'], 300):
            continue
        if r['others'] and not r['mine_last']:
            out.append(r['id'])
            continue
        with db:
            batch = db.execute("INSERT INTO batch (conversation, state, created_at, done_at) "
                               "VALUES (?, 'answered', ?, ?)", (r['id'], now(), now())).lastrowid
            db.execute('UPDATE message SET batch=? WHERE conversation=? AND batch IS NULL', (batch, r['id']))
    return out


def watcher_start(cfg, db, source):
    saved = db.execute("SELECT since FROM cursor WHERE source=? AND account='*'", (source,)).fetchone()
    oldest = saved[0] if saved else db.execute('SELECT MIN(since) FROM cursor WHERE source=?', (source,)).fetchone()[0]
    if source == 'teams':
        oldest = db.execute('SELECT MIN(since) FROM cursor WHERE source=?', (source,)).fetchone()[0]
    current = dt.datetime.now(dt.timezone.utc)
    start = max(parse(oldest), current - MAX_CATCH_UP) if oldest else (
        current - dt.timedelta(minutes=cfg['start']['lookback_minutes']))
    with db:
        db.execute("INSERT OR IGNORE INTO cursor VALUES (?, '*', ?)", (source, iso(start)))
    return parse(iso(start))


def watcher(cfg, spec, lines, stop, processes):
    db = connect(cfg['db']['path'])
    p = None
    try:
        while not stop.is_set():
            try:
                start = watcher_start(cfg, db, spec['source'])
                command = [sys.executable if c == '{python}' else c for c in spec['command']] + ['--since', iso(start)]
                if spec['source'] in ('teams', 'outlook'):
                    for account in db.execute("SELECT account FROM cursor WHERE source=? AND account!='*' ORDER BY account",
                                              (spec['source'],)):
                        command += ['--expected-account', account[0]]
                log.info('%s watcher starting from %s', spec['source'], iso(start))
                p = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, text=True, encoding='utf-8',
                                     errors='strict')
                processes[spec['source']] = p
                for line in p.stdout:
                    if stop.is_set():
                        break
                    if line.strip():
                        lines.put((spec['source'], line))
                if not stop.is_set():
                    log.warning('%s watcher exited with code %s', spec['source'], p.wait())
            except (OSError, UnicodeError) as e:
                log.warning('%s watcher failed: %s', spec['source'], e)
            finally:
                if p:
                    terminate(p)
                    processes.pop(spec['source'], None)
                    p = None
            stop.wait(30)
    finally:
        db.close()


def run(cfg):
    with instance_lock(cfg['db']['path']):
        _run(cfg)


def _run(cfg):
    db = connect(cfg['db']['path'])
    lines, stop, processes = queue.Queue(), threading.Event(), {}
    cfg['_stop'] = stop
    automatic_work = cfg.get('dispatch', {}).get('enabled') is True
    resumed = work.recover(cfg, db) if automatic_work else []
    if not automatic_work:
        log.info('observe-only: source ingestion active, automatic work and approval handling paused')
    if resumed:
        log.info('collecting replies of batches delivered before the restart: %s', resumed)
    stop_file = Path(cfg['db']['path'] + '.stop')
    stop_file.unlink(missing_ok=True)
    watchers = []
    if automatic_work and cfg.get('approval', {}).get('enabled') is True:
        thread = threading.Thread(target=approval.loop, args=(cfg, stop), daemon=True, name='approval')
        watchers.append(thread)
        thread.start()
    for spec in cfg['watchers']:
        t = threading.Thread(target=watcher, args=(cfg, spec, lines, stop, processes),
                             daemon=True, name='watch-' + spec['source'])
        watchers.append(t)
        t.start()
    runs, archived_at = {}, 0
    try:
        while not stop_file.exists():
            try:
                until = time.monotonic() + 1
                for _ in range(500):
                    if time.monotonic() >= until or stop_file.exists():
                        break
                    source, line = lines.get(timeout=0.2)
                    try:
                        m = json.loads(line)
                        if not isinstance(m, dict) or m.get('source') != source:
                            raise ValueError('source mismatch')
                        if not automatic_work or not approval.notes_control(cfg, db, m):
                            ingest(db, m)
                    except (ValueError, KeyError, TypeError) as e:
                        log.warning('bad %s watcher line: %s', source, e)
            except queue.Empty:
                pass
            for conversation in (due(cfg, db) if automatic_work else []):
                if conversation in runs and runs[conversation].is_alive():
                    continue
                runs[conversation] = threading.Thread(target=work.run, args=(cfg, conversation), daemon=True)
                runs[conversation].start()
            runs = {c: t for c, t in runs.items() if t.is_alive()}
            if automatic_work and time.time() - archived_at > 600:
                archived_at = time.time()
                work.archive_idle(cfg, db)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        for p in list(processes.values()):
            terminate(p)
        for t in watchers:
            t.join(timeout=20)
        stop_file.unlink(missing_ok=True)
        db.close()
        log.info('dispatcher stopped; delivered turns remain recoverable')


def status(cfg, limit):
    db = connect(cfg['db']['path'])
    print('dispatch   ' + ('enabled' if cfg.get('dispatch', {}).get('enabled') is True else 'observe-only (work paused)'))
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
    try:
        b = work._row(db, 'batch', batch)
        if b and b['state'] in ('failed', 'interrupted') and (b['delivered_at'] or b['prompt_id']):
            try:
                work.resume_batch(cfg, db, batch)
            except Exception as error:
                work._finish(db, batch, 'failed', '%s: %s' % (type(error).__name__, error))
                raise
            print('reply of batch %d collected without resending' % batch)
            return
        with db:
            released = db.execute('UPDATE message SET batch=NULL WHERE batch=? AND batch IN '
                                  "(SELECT id FROM batch WHERE state IN ('failed', 'interrupted'))", (batch,)).rowcount
            db.execute("UPDATE batch SET state='retried', done_at=? WHERE id=? AND state IN ('failed', 'interrupted')",
                       (now(), batch))
        print('%d message(s) of batch %d back in the queue' % (released, batch))
    finally:
        db.close()


def main():
    ap = argparse.ArgumentParser(prog='python -m dispatcher')
    ap.add_argument('--config', default=str(ROOT / 'config.toml'))
    sub = ap.add_subparsers(dest='command', required=True)
    rn = sub.add_parser('run', help='watch, triage, correlate and deliver until stopped')
    rn.add_argument('--lookback', type=int, help='minutes of catch-up for a source with no cursor yet')
    st = sub.add_parser('status', help='counts, recent triage decisions, work items, drafts')
    st.add_argument('--limit', type=int, default=20)
    rt = sub.add_parser('retry', help='put the messages of a failed batch back in the queue')
    rt.add_argument('batch', type=int)
    review = sub.add_parser('draft', help='show exact draft and destination, register local review')
    review.add_argument('draft', type=int)
    answer = sub.add_parser('reply', help='record approval or revision of a locally reviewed draft')
    answer.add_argument('draft', type=int)
    answer.add_argument('text')
    sub.add_parser('stop', help='stop dispatcher and its watcher processes without losing queued work')
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    cfg = config.load(args.config)
    if args.command == 'run':
        if args.lookback is not None:
            cfg['start']['lookback_minutes'] = args.lookback
        run(cfg)
    elif args.command == 'status':
        status(cfg, args.limit)
    elif args.command == 'retry':
        retry(cfg, args.batch)
    elif args.command in ('draft', 'reply'):
        import uuid
        db = connect(cfg['db']['path'])
        try:
            if args.command == 'draft':
                d = approval.present(db, args.draft, 'local', 'operator', 'local-review')
                print(json.dumps({k: d[k] for k in ('id', 'source', 'account', 'native_id', 'title', 'status', 'text')},
                                 ensure_ascii=False, indent=2))
            else:
                result = approval.decide(db, args.draft, channel='local', target='operator',
                                         event_id=uuid.uuid4().hex, text=args.text, actor_is_me=True, at=now())
                print(json.dumps({'decision': result, 'sending_enabled': approval.sending_enabled(cfg)}))
        finally:
            db.close()
    else:
        Path(cfg['db']['path'] + '.stop').touch()
        print('stop requested')


if __name__ == '__main__':
    main()
