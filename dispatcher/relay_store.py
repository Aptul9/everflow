"""Read-only snapshot of teamsrelay's saved messages. Runs locally in tests or on the relay host over stdin."""
import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path


def readonly(path):
    db = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=8)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    return db


def snapshot(root, owner, since_ms):
    root = Path(root)
    app = readonly(root / 'app.db')
    try:
        slots = app.execute('SELECT t.slot FROM teams_accounts t JOIN "user" u ON u.id=t.owner_id '
                            'WHERE t.stopped=0 AND lower(u.email)=? ORDER BY t.slot', (owner.lower(),)).fetchall()
    finally:
        app.close()
    out = {'accounts': [], 'errors': []}
    for slot_row in slots:
        slot = slot_row['slot']
        db = None
        try:
            db = readonly(root / str(slot) / 'messages.db')
            db.execute('BEGIN')
            state = dict(db.execute("SELECT k,v FROM state WHERE k IN ('me','last_scan_ts')"))
            identity = json.loads(state.get('me') or '{}')
            email = (identity.get('email') or '').lower()
            scan_at = int(state.get('last_scan_ts') or 0)
            if not email or not scan_at:
                raise ValueError('identity or completed scan missing')
            messages = []
            for row in db.execute('SELECT chat,mid,author,text,mine,extra FROM chat_messages '
                                  "WHERE mid GLOB '[0-9]*' AND mid NOT GLOB '*[^0-9]*' AND CAST(mid AS INTEGER)>=? "
                                  'ORDER BY CAST(mid AS INTEGER),chat', (since_ms,)):
                extra = json.loads(row['extra'] or '{}')
                if extra.get('deleted') or extra.get('deletetime'):
                    continue
                stamp = dt.datetime.fromtimestamp(int(row['mid']) / 1000, dt.timezone.utc)
                messages.append({'chat': row['chat'], 'id': row['mid'], 'author': row['author'],
                                 'text': row['text'], 'mine': bool(row['mine']),
                                 'time': stamp.isoformat().replace('+00:00', 'Z'),
                                 'files': extra.get('files') or [], 'quote': extra.get('quote')})
            out['accounts'].append({'slot': slot, 'email': email, 'scan_at': scan_at, 'messages': messages})
        except (sqlite3.Error, ValueError, OSError) as e:
            out['errors'].append('slot %s: %s' % (slot, e))
        finally:
            if db:
                db.close()
    if not slots:
        out['errors'].append('no running accounts found for configured owner')
    return out


if __name__ == '__main__':
    print(json.dumps(snapshot(sys.argv[1], sys.argv[2], int(sys.argv[3])), ensure_ascii=False))
