"""Read teamsrelay stores through SSH and print normalized JSON lines, without MCP or read receipts."""
import argparse
import datetime as dt
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

from . import relay_store

OVERLAP = dt.timedelta(minutes=2)


def parse_iso(s):
    t = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


class Relay:
    def __init__(self, host, root, owner):
        if not host or host.startswith('-'):
            raise ValueError('invalid relay SSH host')
        self.host, self.root, self.owner = host, root, owner

    def snapshot(self, since):
        command = 'python3 - %s %s %d' % (shlex.quote(self.root), shlex.quote(self.owner), int(since.timestamp() * 1000))
        result = subprocess.run(['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
                                 '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', self.host, command],
                                input=Path(relay_store.__file__).read_text(encoding='utf-8'),
                                capture_output=True, encoding='utf-8', timeout=60)
        if result.returncode:
            raise RuntimeError('relay SSH read failed: ' + result.stderr.strip()[:300])
        return json.loads(result.stdout)


def record(email, slot, chat, m):
    text = m.get('text') or ''
    quote = m.get('quote')
    if isinstance(quote, dict) and quote.get('text'):
        text = '> in reply to %s: %s\n%s' % (quote.get('author') or '?', quote['text'], text)
    return {'source': 'teamsrelay', 'account': email, 'conversation_id': chat, 'conversation_title': chat,
            'message_id': '%s/%s;messageid=%s' % (email, chat, m['id']), 'sender': m.get('author') or '',
            'sender_name': m.get('author') or '', 'sender_is_me': bool(m.get('mine')), 'sent_at': m['time'],
            'text': text, 'attachments': [{'name': (f.get('name') or f.get('title') or '?') if isinstance(f, dict)
                                         else str(f), 'size': None} for f in m.get('files') or []],
            'ref': {'chat': chat, 'id': m['id'], 'account': email, 'relay_slot': slot}}


def watch_round(relay, since, state, emit):
    result = relay.snapshot(since)
    seen = state.setdefault('seen', set())
    for account in result['accounts']:
        for m in account['messages']:
            key = (account['slot'], m['chat'], m['id'])
            if key not in seen and parse_iso(m['time']) >= since:
                emit(record(account['email'], account['slot'], m['chat'], m))
                seen.add(key)
    if result.get('errors'):
        raise RuntimeError('; '.join(result['errors']))
    # Relay saves chat bodies after its list scan. Keep a restart overlap for that lag.
    safe = min([a['scan_at'] for a in result['accounts']] + [time.time()]) - 120
    emit({'source': 'teamsrelay', 'checkpoint': dt.datetime.fromtimestamp(safe, dt.timezone.utc).isoformat()
          .replace('+00:00', 'Z')})
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--since', required=True)
    ap.add_argument('--poll', type=int, default=30)
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--host', default=os.environ.get('INBOX_RELAY_HOST', 'oe-vm'))
    ap.add_argument('--data-dir', default='/opt/teamsrelay/data')
    ap.add_argument('--owner', default=os.environ.get('INBOX_RELAY_OWNER', 'aptul99@gmail.com'))
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    relay, since, state = Relay(args.host, args.data_dir, args.owner), parse_iso(args.since) - OVERLAP, {}
    failing = None
    while True:
        try:
            watch_round(relay, since, state, lambda r: print(json.dumps(r, ensure_ascii=False), flush=True))
            failing = None
        except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired) as e:
            if str(e) != failing:
                print('watch_teamsrelay: %s' % e, file=sys.stderr, flush=True)
            failing = str(e)
        if args.once:
            raise SystemExit(1 if failing else 0)
        time.sleep(args.poll)


if __name__ == '__main__':
    main()
