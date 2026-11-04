"""Approval of displayed text and destination. Shadow mode exits before any outbound transport."""
import datetime as dt
import hashlib
import json
import logging
import re
import urllib.parse

from .db import now, parse

log = logging.getLogger('dispatcher')


def draft(db, draft_id):
    row = db.execute('SELECT d.*,c.source,c.account,c.native_id,c.title,w.session_id FROM draft d '
                     'LEFT JOIN conversation c ON c.id=d.conversation JOIN work_item w ON w.id=d.work_item '
                     'WHERE d.id=?', (draft_id,)).fetchone()
    if row is None:
        raise ValueError('draft %s not found' % draft_id)
    return dict(row)


def fingerprint(d):
    value = {k: d[k] for k in ('work_item', 'conversation', 'source', 'account', 'native_id', 'text')}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def sending_enabled(cfg):
    return cfg.get('mode', {}).get('shadow', True) is False and cfg.get('delivery', {}).get('enabled') is True


def present(db, draft_id, channel, target, anchor, at=None):
    d = draft(db, draft_id)
    if d['status'] != 'pending' or not d['conversation']:
        raise ValueError('draft is not pending with a valid target')
    if channel not in ('session', 'notes', 'local') or (channel == 'session' and target != d['session_id']):
        raise ValueError('invalid approval channel or session')
    with db:
        db.execute('INSERT INTO approval_request VALUES (?,?,?,?,?,?) ON CONFLICT(draft,channel,target) '
                   'DO UPDATE SET anchor=excluded.anchor,shown_at=excluded.shown_at '
                   "WHERE approval_request.anchor LIKE 'draft:%' AND approval_request.fingerprint=excluded.fingerprint",
                   (draft_id, channel, target, fingerprint(d), anchor, at or now()))
    return d


def decide(db, draft_id, *, channel, target, event_id, text, actor_is_me, at):
    if actor_is_me is not True or not isinstance(text, str) or not text.strip():
        return 'rejected'
    with db:
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT 1 FROM approval_event WHERE channel=? AND target=? AND event_id=?',
                      (channel, target, event_id)).fetchone():
            return 'duplicate'
        shown = db.execute('SELECT * FROM approval_request WHERE draft=? AND channel=? AND target=?',
                           (draft_id, channel, target)).fetchone()
        if not shown or event_id == shown['anchor'] or parse(at) <= parse(shown['shown_at']):
            return 'rejected'
        if channel == 'session' and db.execute('SELECT 1 FROM batch WHERE prompt_id=?', (event_id,)).fetchone():
            return 'rejected'
        d = draft(db, draft_id)
        if d['status'] != 'pending':
            return d['status']
        if fingerprint(d) != shown['fingerprint']:
            db.execute("UPDATE draft SET status='stale',updated_at=? WHERE id=?", (now(), draft_id))
            return 'stale'
        explicit = re.fullmatch(r'ok\s+(\d+)', text.strip(), re.I)
        if explicit and int(explicit.group(1)) != draft_id:
            return 'rejected'
        approved = text.strip().casefold() == 'ok' or bool(explicit)
        if approved and channel not in ('session', 'notes'):
            return 'rejected'
        db.execute('INSERT INTO approval_event (draft,channel,target,event_id,action,body,fingerprint,state,at) '
                   'VALUES (?,?,?,?,?,?,?,?,?)', (draft_id, channel, target, event_id,
                    'approve' if approved else 'revise', text.strip(), shown['fingerprint'], 'pending', at))
        status = 'approved' if approved else 'revision_requested'
        db.execute('UPDATE draft SET status=?,updated_at=? WHERE id=?', (status, now(), draft_id))
    return status


def control(db, channel, target, event_id, text, actor_is_me, at):
    if actor_is_me is not True or not isinstance(text, str) or not text.strip():
        return 'rejected'
    if db.execute('SELECT 1 FROM approval_event WHERE channel=? AND target=? AND event_id=?',
                  (channel, target, event_id)).fetchone():
        return 'duplicate'
    rows = db.execute('SELECT r.draft FROM approval_request r JOIN draft d ON d.id=r.draft '
                      "WHERE r.channel=? AND r.target=? AND d.status='pending'", (channel, target)).fetchall()
    explicit = re.fullmatch(r'ok\s+(\d+)', text.strip(), re.I)
    if explicit:
        rows = [r for r in rows if r['draft'] == int(explicit.group(1))]
    if len(rows) != 1:
        return 'ambiguous' if rows else 'unshown'
    return decide(db, rows[0]['draft'], channel=channel, target=target, event_id=event_id, text=text,
                  actor_is_me=True, at=at)


def notes_control(cfg, db, message):
    settings = cfg.get('approval', {})
    account = (settings.get('notes_account') or '').lower()
    if settings.get('enabled') is not True or not account or (
            message.get('source'), message.get('account', '').lower(), message.get('conversation_id'),
            message.get('sender_is_me')) != ('teams', account, '48:notes', True):
        return False
    text = message.get('text') or ''
    if not text.startswith('[inbox-dispatcher]'):
        result = control(db, 'notes', account + '/48:notes', message['message_id'], text, True, message['sent_at'])
        log.info('notes decision %s: %s', message['message_id'], result)
    return True


def poll_sessions(cfg, db, oc):
    if cfg.get('approval', {}).get('enabled') is not True:
        return
    from .work import DRAFT_RX
    rows = db.execute('SELECT d.*,w.session_id,c.native_id,b.prompt_id '
                      'FROM draft d JOIN work_item w ON w.id=d.work_item JOIN conversation c ON c.id=d.conversation '
                      "JOIN batch b ON b.id=d.batch WHERE d.status='pending' AND w.session_id IS NOT NULL "
                      'AND b.prompt_id IS NOT NULL').fetchall()
    for session in {r['session_id'] for r in rows}:
        pending = [r for r in rows if r['session_id'] == session]
        remaining = {r['prompt_id'] for r in pending}
        cursor, messages = None, []
        for _ in range(100):
            query = {'limit': '50'}
            if cursor:
                query['cursor'] = cursor
            else:
                query['order'] = 'desc'
            page = oc.call('GET', '/api/session/%s/message?%s' % (session, urllib.parse.urlencode(query)))
            messages.extend(page['data'])
            remaining.difference_update(m.get('id') for m in page['data'])
            cursor = (page.get('cursor') or {}).get('next')
            if not cursor or not remaining:
                break
        else:
            raise RuntimeError('approval message pagination limit reached')
        timeline = list(reversed(messages))
        for row in pending:
            start = next((i for i, m in enumerate(timeline) if m.get('id') == row['prompt_id']), None)
            if start is None:
                continue
            turn = []
            for message in timeline[start + 1:]:
                if message.get('type') == 'user':
                    break
                turn.append(message)
            outcomes = [m.get('outcome') for m in turn if m.get('type') == 'idle']
            if not outcomes or outcomes[-1] != 'succeeded':
                continue
            for message in reversed(turn):
                completed = message.get('time', {}).get('completed')
                if message.get('type') != 'assistant' or not completed or not message.get('id', '').startswith('msg_'):
                    continue
                text = '\n'.join(c['text'] for c in message.get('content') or [] if c.get('type') == 'text')
                matches = [(target.strip().strip('"\''), body.strip()) for target, body in DRAFT_RX.findall(text)]
                if not any(target in (str(row['conversation']), row['native_id']) and body == row['text']
                           for target, body in matches):
                    continue
                stamp = dt.datetime.fromtimestamp(completed / 1000, dt.timezone.utc)
                present(db, row['id'], 'session', session, message['id'],
                        at=stamp.isoformat(timespec='microseconds').replace('+00:00', 'Z'))
                break
        for message in timeline:
            if message.get('type') != 'user':
                continue
            stamp = dt.datetime.fromtimestamp(message['time']['created'] / 1000, dt.timezone.utc)
            result = control(db, 'session', session, message['id'], message.get('text') or '', True,
                             stamp.isoformat().replace('+00:00', 'Z'))
            if result != 'duplicate':
                log.info('session %s decision %s: %s', session, message['id'], result)


def revise(cfg, db, event_id):
    from . import work
    event = db.execute('SELECT * FROM approval_event WHERE id=?', (event_id,)).fetchone()
    if not event or event['action'] != 'revise' or event['state'] != 'pending':
        return
    d = draft(db, event['draft'])
    with work.session_lock(d['work_item']):
        with db:
            db.execute('BEGIN IMMEDIATE')
            event = db.execute('SELECT * FROM approval_event WHERE id=?', (event_id,)).fetchone()
            if event['state'] != 'pending':
                return
            if draft(db, d['id'])['status'] != 'revision_requested':
                db.execute("UPDATE approval_event SET state='stale' WHERE id=?", (event_id,))
                return
            if work.busy(db, d['conversation']):
                return
            direct = event['channel'] == 'session'
            batch = db.execute("INSERT INTO batch (conversation,work_item,state,created_at,prompt_id,delivered_at) "
                               "VALUES (?,?,'running',?,?,?)", (d['conversation'], d['work_item'], now(),
                                event['event_id'] if direct else None, now() if direct else None)).lastrowid
            db.execute("UPDATE approval_event SET batch=?,state='delivering' WHERE id=?", (batch, event_id))
        try:
            if event['channel'] == 'session':
                prompt_id = event['event_id']  # the user's direct reply already started this turn
            else:
                text = ('[inbox-dispatcher] Revise draft #%d for Conversation %d.\n%s\n%s\n'
                        'Previous draft:\n%s\nAntonio\'s revision:\n%s\n'
                        'End with the replacement DRAFT block and STATUS line.' % (
                            d['id'], d['conversation'], work.local_time(), work.RULES, d['text'], event['body']))
                prompt_id = work.submit(db, work.client(cfg), batch, d['work_item'], d['session_id'], text)
            with db:
                db.execute('UPDATE batch SET prompt_id=?,delivered_at=? WHERE id=?', (prompt_id, now(), batch))
                db.execute("UPDATE approval_event SET state='running' WHERE id=?", (event_id,))
            work.collect(cfg, db, batch)
        except Exception as e:
            work._finish(db, batch, 'failed', str(e))
            with db:
                db.execute("UPDATE approval_event SET state='failed',error=? WHERE id=?", (str(e), event_id))
            raise


def deliver(cfg, db, draft_id, reader, sender):
    if not sending_enabled(cfg):
        return 'shadow'
    with db:
        db.execute('BEGIN IMMEDIATE')
        previous = db.execute('SELECT * FROM send_attempt WHERE draft=?', (draft_id,)).fetchone()
        if previous and previous['state'] in ('sent', 'sending', 'uncertain', 'checking'):
            return previous['state'] if previous['state'] != 'sending' else 'uncertain'
        d = draft(db, draft_id)
        consent = db.execute('SELECT e.fingerprint,e.channel,e.target,e.at,r.anchor,r.shown_at FROM approval_event e '
                             'JOIN approval_request r ON r.draft=e.draft AND r.channel=e.channel AND r.target=e.target '
                             "WHERE e.draft=? AND e.action='approve' AND e.channel IN ('session','notes') "
                             "AND e.state!='shadow' ORDER BY e.id DESC LIMIT 1",
                             (draft_id,)).fetchone()
        if d['status'] != 'approved':
            return d['status']
        if not consent:
            return 'blocked'
        if parse(consent['at']) <= parse(consent['shown_at']):
            return 'blocked'
        if consent['channel'] == 'session' and (consent['target'] != d['session_id'] or
                                                not consent['anchor'].startswith('msg_')):
            return 'blocked'
        if consent['channel'] == 'notes' and consent['target'] != (
                (cfg.get('approval', {}).get('notes_account') or '').lower() + '/48:notes'):
            return 'blocked'
        if consent['fingerprint'] != fingerprint(d):
            return 'stale'
        db.execute('INSERT INTO send_attempt VALUES (?,?,\'checking\',NULL,NULL,?) ON CONFLICT(draft) '
                   "DO UPDATE SET state='checking',error=NULL,updated_at=excluded.updated_at",
                   (draft_id, d['idempotency_key'], now()))
    try:
        latest = reader(d)
        if not isinstance(latest, dict) or latest.get('complete') is not True:
            raise ValueError('source reread did not prove complete coverage')
        from .__main__ import ingest
        for message in latest['messages']:
            if (message['source'], message['account'], message['conversation_id']) != (
                    d['source'], d['account'], d['native_id']):
                raise ValueError('source reread returned another conversation')
            ingest(db, message)
    except Exception as e:
        with db:
            db.execute("UPDATE send_attempt SET state='blocked',error=?,updated_at=? WHERE draft=?",
                       ('%s: %s' % (type(e).__name__, e), now(), draft_id))
        return 'blocked'
    with db:
        db.execute('BEGIN IMMEDIATE')
        current = draft(db, draft_id)
        if current['status'] != 'approved' or fingerprint(current) != consent['fingerprint']:
            db.execute("UPDATE send_attempt SET state='blocked',updated_at=? WHERE draft=?", (now(), draft_id))
            return current['status'] if current['status'] != 'approved' else 'stale'
        db.execute("UPDATE draft SET status='sending',updated_at=? WHERE id=?", (now(), draft_id))
        db.execute("UPDATE send_attempt SET state='sending',updated_at=? WHERE draft=?", (now(), draft_id))
    try:
        result = sender(d, d['text'], d['idempotency_key'])
        if not result:
            raise RuntimeError('outbound write has no confirmed result')
        state, error = 'sent', None
    except Exception as e:
        result, state, error = None, 'uncertain', '%s: %s' % (type(e).__name__, e)
    with db:
        db.execute('UPDATE send_attempt SET state=?,result=?,error=?,updated_at=? WHERE draft=?',
                   (state, str(result) if result else None, error, now(), draft_id))
        db.execute('UPDATE draft SET status=?,updated_at=? WHERE id=?', (state, now(), draft_id))
    return state


def tick(cfg, db, oc):
    if cfg.get('approval', {}).get('enabled') is not True:
        return
    poll_sessions(cfg, db, oc)
    for event in db.execute("SELECT * FROM approval_event WHERE state='pending' ORDER BY id").fetchall():
        if event['action'] == 'revise':
            revise(cfg, db, event['id'])
        elif not sending_enabled(cfg):
            with db:
                db.execute("UPDATE approval_event SET state='shadow' WHERE id=?", (event['id'],))
                db.execute("UPDATE draft SET status='pending',updated_at=? WHERE id=? AND status='approved'",
                           (now(), event['draft']))
        else:
            from . import channels
            result = deliver(cfg, db, event['draft'], lambda d: channels.read(cfg, db, d),
                             lambda d, body, key: channels.send(cfg, db, d, body, key))
            with db:
                db.execute('UPDATE approval_event SET state=? WHERE id=?', (result, event['id']))


def loop(cfg, stop):
    from . import work
    from .db import connect
    db = connect(cfg['db']['path'])
    failing = None
    try:
        while not stop.is_set():
            try:
                tick(cfg, db, work.client(cfg))
                failing = None
            except Exception as e:
                if str(e) != failing:
                    log.warning('approval loop: %s: %s', type(e).__name__, e)
                failing = str(e)
            stop.wait(15)
    finally:
        db.close()
