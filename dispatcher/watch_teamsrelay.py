"""Print one JSON line per new message on the Teams accounts the teamsrelay server holds.

The relay runs the Teams accounts that are not in Teams desktop on this PC (Npo, MSC, Zurich, AGAP2, ...). Its /mcp
answers with the bearer MCP_TOKEN. Only read tools are called (list_accounts, list_chats, read_chat), never
refresh_chat: that one opens the chat in Teams and marks it read. read_chat returns the messages the relay agent
saved; the agent saves a chat when a new message shows in its list, so a chat whose list row changed is read again
for a few rounds until the new message is there.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

URL = 'https://teams.everbright.it/mcp'
TOKEN_FILE = Path(__file__).resolve().parent.parent / 'data' / 'teamsrelay.token'
OVERLAP = dt.timedelta(minutes=2)
STALE_IN_A_ROW = 5  # first round: stop reading an account's list after this many chats with nothing new
RECHECK_ROUNDS = 4


def log(text):
    print('watch_teamsrelay: %s' % text, file=sys.stderr, flush=True)


def parse_iso(s):
    t = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


class Relay:
    def __init__(self, url, token):
        self.url, self.token = url, token

    def _post(self, method, params):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode('utf-8')
        req = urllib.request.Request(self.url, data=body, method='POST', headers={
            'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18'})
        with urllib.request.urlopen(req, timeout=60) as r:
            ctype, raw = r.headers.get('Content-Type', ''), r.read().decode('utf-8')
        if 'event-stream' in ctype:
            raw = '\n'.join(line[5:].strip() for line in raw.splitlines() if line.startswith('data:'))
        out = json.loads(raw)
        if out.get('error'):
            raise RuntimeError('%s: %s' % (method, out['error'].get('message')))
        return out['result']

    def initialize(self):
        self._post('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                                  'clientInfo': {'name': 'inbox-dispatcher', 'version': '1'}})

    def tool(self, name, args):
        res = self._post('tools/call', {'name': name, 'arguments': args})
        if res.get('isError'):
            raise RuntimeError('%s: %s' % (name, (res.get('content') or [{}])[0].get('text', '')[:200]))
        return res.get('structuredContent') or json.loads((res.get('content') or [{}])[0].get('text') or '{}')


def record(email, slot, chat, m):
    quote = m.get('quote')
    text = m.get('text') or ''
    if isinstance(quote, dict) and quote.get('text'):
        text = '> in reply to %s: %s\n%s' % (quote.get('author') or '?', quote['text'], text)
    files = m.get('files') or []
    return {
        'source': 'teamsrelay', 'account': email, 'conversation_id': chat, 'conversation_title': chat,
        'message_id': '%s/%s;messageid=%s' % (email, chat, m['id']), 'sender': m.get('author') or '',
        'sender_name': m.get('author') or '', 'sender_is_me': bool(m.get('mine')), 'sent_at': m['time'],
        'text': text,
        'attachments': [{'name': (f.get('name') or f.get('title') or '?') if isinstance(f, dict) else str(f),
                         'size': None} for f in files],
        'ref': {'chat': chat, 'id': m['id'], 'account': email, 'relay_slot': slot},
    }


def watch_round(relay, since, state, emit):
    """One pass over every running account. state carries list rows, rechecks and emitted ids across rounds."""
    rows, recheck, seen = state['rows'], state['recheck'], state['seen']
    for acct in relay.tool('list_accounts', {}).get('accounts', []):
        if acct.get('stopped'):
            continue
        slot, email = acct['slot'], (acct.get('email') or '').lower()
        known = any(k[0] == slot for k in rows)
        stale = 0
        for c in relay.tool('list_chats', {'account': slot}).get('chats', []):
            key, row = (slot, c['name']), (c.get('last'), c.get('preview'))
            changed = rows.get(key) != row
            rows[key] = row
            if known and changed:
                recheck[key] = RECHECK_ROUNDS
            if known and not recheck.get(key):
                continue
            if not known and stale >= STALE_IN_A_ROW:
                continue
            recheck[key] = max(recheck.get(key, 0) - 1, 0)
            try:
                msgs = relay.tool('read_chat', {'account': slot, 'chat': c['name']}).get('messages') or []
            except RuntimeError as e:
                log('slot %s: %s' % (slot, e))
                continue
            fresh = [m for m in msgs if m.get('id') and m.get('time') and not m.get('deleted')
                     and parse_iso(m['time']) >= since and (slot, c['name'], m['id']) not in seen]
            if not known and msgs:
                stale = 0 if fresh else stale + 1
            for m in sorted(fresh, key=lambda m: m['time']):
                seen.add((slot, c['name'], m['id']))
                emit(record(email, slot, c['name'], m))
            if fresh:
                recheck[key] = 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--since', required=True, help='ISO time; UTC when it has no offset')
    ap.add_argument('--poll', type=int, default=30, help='seconds between rounds')
    ap.add_argument('--once', action='store_true', help='one round, then exit')
    ap.add_argument('--url', default=URL)
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    token = os.environ.get('INBOX_TEAMSRELAY_TOKEN') or TOKEN_FILE.read_text(encoding='ascii').strip()
    relay = Relay(args.url, token)
    since = parse_iso(args.since) - OVERLAP
    state = {'rows': {}, 'recheck': {}, 'seen': set()}
    failing = None
    while True:
        try:
            relay.initialize()
            watch_round(relay, since, state, lambda r: print(json.dumps(r, ensure_ascii=False), flush=True))
            failing = None
        except (urllib.error.URLError, RuntimeError, ValueError, OSError) as e:
            if str(e) != failing:
                log('round failed, retrying every %d s: %s: %s' % (args.poll, type(e).__name__, e))
            failing = str(e)
        if args.once:
            return
        time.sleep(args.poll)


if __name__ == '__main__':
    main()
