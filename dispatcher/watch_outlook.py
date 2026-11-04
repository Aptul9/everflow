"""Print one JSON line per new item in the Inbox and Sent Items of every Outlook account.

Attaches to the running Classic Outlook with GetActiveObject and never starts one: COM
would start a hidden OUTLOOK.EXE -Embedding that does not sync new mail. Catch-up is
Items.Restrict from --since, push is NewMailEx, and a re-scan every --poll seconds
covers what the event misses (Sent Items, stores it does not fire for, a restart).
"""
import argparse
import datetime as dt
import json
import sys
import time

import pythoncom
import win32com.client

INBOX, SENT = 6, 5
KINDS = {43, 53, 54}  # mail, meeting request, meeting cancellation
PR_INTERNET_MESSAGE_ID = 'http://schemas.microsoft.com/mapi/proptag/0x1035001F'
PR_SENDER_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'
OVERLAP = dt.timedelta(minutes=2)
MAX_TEXT = 50000


def log(text):
    print('watch_outlook: %s' % text, file=sys.stderr, flush=True)


def parse_iso(s):
    t = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def utc(t):
    """COM dates are local wall-clock time that pywin32 labels UTC."""
    return dt.datetime(t.year, t.month, t.day, t.hour, t.minute, t.second).astimezone(dt.timezone.utc)


def iso(t):
    return t.isoformat().replace('+00:00', 'Z')


def since_filter(sent, since):
    # DASL compares in UTC with an ISO date; Jet [ReceivedTime] strings follow the Windows locale.
    prop = 'date' if sent else 'datereceived'
    return '@SQL="urn:schemas:httpmail:%s" >= \'%s\'' % (prop, since.strftime('%Y-%m-%d %H:%M'))


def sender_smtp(item):
    if item.SenderEmailType == 'EX':  # Exchange senders carry an X.500 DN, not an address
        try:
            return item.Sender.GetExchangeUser().PrimarySmtpAddress
        except Exception:
            try:
                return item.PropertyAccessor.GetProperty(PR_SENDER_SMTP)
            except Exception:
                pass
    return item.SenderEmailAddress or ''


def record(item, account, mine, sent):
    sender = sender_smtp(item).lower()
    try:
        message_id = item.PropertyAccessor.GetProperty(PR_INTERNET_MESSAGE_ID)
    except Exception:
        message_id = ''
    topic = item.ConversationTopic or item.Subject or ''
    return {
        'source': 'outlook',
        'account': account,
        'conversation_id': item.ConversationID or 'topic:' + topic,
        'conversation_title': topic,
        'message_id': message_id or item.EntryID,
        'sender': sender,
        'sender_name': item.SenderName or '',
        'sender_is_me': sent or sender in mine,
        'sent_at': iso(utc(item.SentOn if sent else item.ReceivedTime)),
        'text': (item.Body or '')[:MAX_TEXT],
        'attachments': [{'name': a.FileName, 'size': a.Size} for a in item.Attachments],
        'ref': {'entry_id': item.EntryID, 'store_id': item.Parent.StoreID},
    }


def emit(item, account, mine, sent, seen):
    try:
        if item.Class not in KINDS:
            return
        rec = record(item, account, mine, sent)
    except pythoncom.com_error as e:
        log('skipped one item in %s: %s' % (account, e))
        return
    if rec['message_id'] in seen:
        return
    seen.add(rec['message_id'])
    print(json.dumps(rec, ensure_ascii=False), flush=True)


class Events:
    pending = []

    def OnNewMailEx(self, entry_ids):
        Events.pending.extend(i for i in entry_ids.split(',') if i)


def watch(state, poll, once, seen):
    app = win32com.client.GetActiveObject('Outlook.Application')
    ns = app.GetNamespace('MAPI')
    folders, stores = [], {}
    for acct in ns.Accounts:
        account = acct.SmtpAddress.lower()
        try:
            store = acct.DeliveryStore
            folders += [(account, store.GetDefaultFolder(INBOX), False), (account, store.GetDefaultFolder(SENT), True)]
            stores[store.StoreID] = account
        except pythoncom.com_error as e:
            log('no folders for %s: %s' % (account, e))
    mine = set(stores.values())
    events = None if once else win32com.client.WithEvents(app, Events)  # the sink lives as long as this reference
    log('watching %s from %s' % (', '.join(sorted(mine)), iso(state['since'])))
    state.pop('failing', None)
    while True:
        started = dt.datetime.now(dt.timezone.utc)
        for account, folder, sent in folders:
            for item in folder.Items.Restrict(since_filter(sent, state['since'] - OVERLAP)):
                emit(item, account, mine, sent, seen)
        state['since'] = started
        if once:
            return
        deadline = time.time() + poll
        while time.time() < deadline:
            pythoncom.PumpWaitingMessages()
            while Events.pending:
                try:
                    item = ns.GetItemFromID(Events.pending.pop(0))
                    account = stores.get(item.Parent.StoreID)
                except pythoncom.com_error:
                    continue
                if account:
                    emit(item, account, mine, False, seen)
            time.sleep(0.5)
        app.Name  # raises once this Outlook has exited, so the caller re-attaches


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--since', required=True, help='ISO time; UTC when it has no offset')
    ap.add_argument('--poll', type=int, default=60, help='seconds between re-scans')
    ap.add_argument('--once', action='store_true', help='catch up and exit')
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    pythoncom.CoInitialize()
    state, seen = {'since': parse_iso(args.since)}, set()
    while True:
        try:
            watch(state, args.poll, args.once, seen)
            if args.once:
                return
        except pythoncom.com_error as e:
            # Once per outage: a closed Outlook otherwise writes a line every 30 s all night. watch() clears it on attach.
            if str(e) != state.get('failing'):
                log('Outlook not reachable (%s); retrying every 30 s. Classic Outlook must be open; '
                    'after a scripted start click into its window once.' % e)
            state['failing'] = str(e)
            time.sleep(30)


if __name__ == '__main__':
    main()
