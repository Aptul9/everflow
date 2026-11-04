"""Direct source rereads and gated text replies. Delivery is never used during shadow mode."""
import datetime as dt
import functools
import importlib.util
import json
import os
from pathlib import Path
import sys

from .approval import sending_enabled
from .db import parse


@functools.lru_cache(maxsize=1)
def _teams(path):
    os.environ['TEAMS_MCP_NO_RESTART'] = '1'
    path = Path(path)
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location('dispatcher_teams', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def teams(cfg):
    command = next(w['command'] for w in cfg['watchers'] if w['source'] == 'teams')
    return _teams(next(p for p in command if p.endswith('teams_mcp.py')))


def _outlook():
    import win32com.client
    return win32com.client.GetActiveObject('Outlook.Application').GetNamespace('MAPI')


def read(cfg, db, d):
    if d['source'] not in ('outlook', 'teams'):
        raise RuntimeError('live source reread unavailable for %s; delivery held' % d['source'])
    # Revisions have no new source messages. Keep the conversation's original context boundary.
    after = db.execute('SELECT MIN(sent_at) FROM message WHERE conversation=?', (d['conversation'],)).fetchone()[0]
    if not after:
        raise RuntimeError('source context unavailable; delivery held')
    after = parse(after)
    if d['source'] == 'outlook':
        import pythoncom
        from . import watch_outlook as outlook
        pythoncom.CoInitialize()
        try:
            ns = _outlook()
            account = next((a for a in ns.Accounts if a.SmtpAddress.lower() == d['account'].lower()), None)
            if account is None:
                raise RuntimeError('Outlook account not available')
            mine, messages = {a.SmtpAddress.lower() for a in ns.Accounts}, []
            for kind, sent in ((outlook.INBOX, False), (outlook.SENT, True)):
                folder = account.DeliveryStore.GetDefaultFolder(kind)
                for item in folder.Items.Restrict(outlook.since_filter(sent, after)):
                    if item.Class in outlook.KINDS and item.ConversationID == d['native_id']:
                        record = outlook.record(item, d['account'], mine, sent)
                        if parse(record['sent_at']) >= after:
                            messages.append(record)
            return {'complete': True, 'messages': messages}
        finally:
            pythoncom.CoUninitialize()
    module = teams(cfg)
    remote = module.remote()
    account = remote._account(d['account'])
    cutoff = int(after.timestamp() * 1000)
    url = '%s/api/chatsvc/%s/v1/users/ME/conversations/%s/messages?view=msnp24Equivalent&pageSize=200&startTime=%d' % (
        remote.SERVER, account['region'], module.urllib.parse.quote(d['native_id'], safe=''), cutoff)
    raw = module._pages(remote, account, url, 'messages', cutoff)
    me, messages = remote._jwt(account['ic3']).get('oid'), []
    for message in raw:
        kind = message.get('messagetype') or ''
        deleted = bool((message.get('properties') or {}).get('deletetime'))
        if not deleted and (not kind or kind.startswith(module.WATCH_SKIP_TYPES)):
            continue
        stamp = remote.iso_ms(message.get('originalarrivaltime'))
        if stamp < cutoff:
            continue
        sender = module._sender_oid(message)
        messages.append({'source': 'teams', 'account': d['account'], 'conversation_id': d['native_id'],
                         'conversation_title': d['title'], 'message_id': '%s;messageid=%s' % (d['native_id'], message['id']),
                         'sender': sender, 'sender_name': message.get('imdisplayname') or '',
                         'sender_is_me': bool(me) and sender == me,
                         'sent_at': dt.datetime.fromtimestamp(stamp / 1000, dt.timezone.utc).isoformat(),
                         'text': '' if deleted else module.message_text(remote.norm_message(message, d['native_id'])),
                         'attachments': [] if deleted else [
                             {'name': a['name'] or a['kind'], 'size': None} for a in module.extract_attachments(message)],
                         'ref': {'chat': d['native_id'], 'id': message['id'], 'account': d['account'], 'deleted': deleted}})
    return {'complete': True, 'messages': messages}


def send(cfg, db, d, body, key):
    if not sending_enabled(cfg):
        raise RuntimeError('delivery is disabled')
    if d['source'] == 'teams':
        result = teams(cfg).remote().send_message({'account': d['account'], 'id': d['native_id']}, text=body)
        if result.get('status') not in (200, 201, 202):
            raise RuntimeError('Teams did not acknowledge submission')
        return result.get('clientmessageid')
    if d['source'] == 'outlook':
        import pythoncom
        pythoncom.CoInitialize()
        try:
            ns = _outlook()
            reference = db.execute('SELECT ref FROM message WHERE conversation=? AND sender_is_me=0 '
                                   'ORDER BY sent_at DESC,id DESC LIMIT 1', (d['conversation'],)).fetchone()
            reference = json.loads(reference['ref'])
            item = ns.GetItemFromID(reference['entry_id'], reference.get('store_id'))
            if item.ConversationID != d['native_id']:
                raise RuntimeError('Outlook target conversation changed')
            account = next((a for a in ns.Accounts if a.SmtpAddress.lower() == d['account'].lower()), None)
            if account is None:
                raise RuntimeError('Outlook sending account not available')
            reply = item.ReplyAll()
            reply.SendUsingAccount = account
            reply.Body = body
            reply.Send()
            return 'outlook:submitted:' + key  # submission accepted, not recipient-delivery proof
        finally:
            pythoncom.CoUninitialize()
    raise RuntimeError('sending unsupported for ' + d['source'])
