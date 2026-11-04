"""Client for the opencode v2 HTTP API, the subset the dispatcher needs."""
import base64
import json
import urllib.error
import urllib.parse
import urllib.request

# Outbound actions a dispatcher session never gets. MCP permission actions are `<server>_<tool>` with the
# server name as configured, hyphen included (`outlook-desktop_send_email`).
DENY = ['teams*_send*', 'teams*_edit*', 'teams*_delete*',
        'outlook*_send*', 'outlook*_reply*', 'outlook*_forward*', 'outlook*_respond*',
        'outlook*_create_meeting*', 'outlook*_create_event*', 'outlook*_update_event*', 'outlook*_delete_event*',
        'gmail*_send*', 'gchat*_send*', 'slack*_send*', 'slack*_post*']


class Opencode:
    def __init__(self, url, password, username='opencode'):
        self.url = url.rstrip('/')
        self.auth = 'Basic ' + base64.b64encode(('%s:%s' % (username, password)).encode()).decode()

    def call(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method,
                                     headers={'Authorization': self.auth, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError('opencode %s %s: HTTP %d %s' % (method, path, e.code, e.read()[:300])) from None
        return json.loads(raw) if raw else None

    def create(self, title, directory, model=None, metadata=None):
        body = {'title': title, 'location': {'directory': directory}, 'metadata': metadata or {},
                'permissions': [{'action': a, 'resource': '*', 'effect': 'deny'} for a in DENY]}
        if model:
            provider, _, model_id = model.partition('/')
            body['model'] = {'providerID': provider, 'id': model_id}
        return self.call('POST', '/api/session', body)['data']['id']

    def prompt(self, session, text):
        """Queue a turn. A busy session keeps it in its inbox until the running turn ends."""
        out = self.call('POST', '/api/session/%s/prompt' % session, {'text': text, 'delivery': 'queue'})
        return out['data']['id']

    def wait(self, session):
        self.call('POST', '/api/experimental/session/%s/wait' % session, timeout=None)

    def archive(self, session, archived=True):
        self.call('PATCH', '/api/session/%s' % session, {'archived': archived})

    def turn(self, session, prompt_id):
        """Assistant text written after the given user message, oldest first, and the turn outcome."""
        texts, outcome, cursor = [], None, None
        while True:
            q = {'order': 'desc', 'limit': '50'}
            if cursor:
                q['cursor'] = cursor
            page = self.call('GET', '/api/session/%s/message?%s' % (session, urllib.parse.urlencode(q)))
            for m in page['data']:
                if m.get('id') == prompt_id:
                    return '\n'.join(reversed(texts)), outcome
                if m.get('type') == 'idle' and outcome is None:
                    outcome = m.get('outcome')
                elif m.get('type') == 'assistant':
                    texts.append('\n'.join(c['text'] for c in m.get('content') or [] if c.get('type') == 'text'))
            cursor = (page.get('cursor') or {}).get('next')
            if not cursor:
                raise RuntimeError('prompt %s not found in session %s' % (prompt_id, session))
