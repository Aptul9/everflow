"""Client for the opencode v2 HTTP API, the subset the dispatcher needs."""
import base64
import http.cookiejar
import json
import urllib.error
import urllib.parse
import urllib.request

# Outbound actions a dispatcher session never gets. MCP permission actions are `<server>_<tool>` with the
# server name as configured, hyphen included (`outlook-desktop_send_email`).
DENY = ['teams*_send*', 'teams*_edit*', 'teams*_delete*', 'teams*_react*', 'teams*_undo*', 'teams*_refresh*',
        'outlook*_send*', 'outlook*_reply*', 'outlook*_forward*', 'outlook*_respond*',
        'outlook*_create_meeting*', 'outlook*_create_event*', 'outlook*_update_event*', 'outlook*_delete_event*',
        'gmail*_send*', 'gchat*_send*', 'slack*_send*', 'slack*_post*']


class Opencode:
    """A plain `opencode serve` takes basic auth. OpenChamber's port forwards the same API to its own server
    and takes its UI password once, answering with a session cookie."""

    def __init__(self, url, password, openchamber=False):
        self.url = url.rstrip('/')
        self.password = password
        self.openchamber = openchamber
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.headers = {'Content-Type': 'application/json'}
        if not openchamber:
            self.headers['Authorization'] = 'Basic ' + base64.b64encode(('opencode:%s' % password).encode()).decode()
        self.signed_in = False

    def sign_in(self):
        data = urllib.parse.urlencode({'password': self.password}).encode('utf-8')
        try:
            with self.opener.open(urllib.request.Request(self.url + '/auth/session', data=data, method='POST'),
                                  timeout=30) as r:
                r.read()
        except urllib.error.HTTPError as e:
            with e:
                raise RuntimeError('OpenChamber sign-in: HTTP %d %s' % (e.code, e.read()[:200])) from None
        self.signed_in = True

    def call(self, method, path, body=None, timeout=60):
        if self.openchamber and not self.signed_in:
            self.sign_in()
        data = json.dumps(body).encode('utf-8') if body is not None else None
        for attempt in range(2):
            req = urllib.request.Request(self.url + path, data=data, method=method, headers=self.headers)
            try:
                with self.opener.open(req, timeout=timeout) as r:
                    raw = r.read()
                return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code == 401 and self.openchamber and not attempt:
                    e.close()
                    self.sign_in()  # the OpenChamber cookie lasts about 12 hours
                    continue
                with e:
                    raise RuntimeError('opencode %s %s: HTTP %d %s' % (method, path, e.code, e.read()[:300])) from None

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

    def queued(self, session):
        return [i['id'] for i in self.call('GET', '/api/session/%s/inbox' % session)['data']]

    def archive(self, session, archived=True):
        self.call('PATCH', '/api/session/%s' % session, {'archived': archived})

    def turn(self, session, prompt_id):
        """Assistant text written after the given user message, oldest first, and the outcome once the session
        is idle again. None while the message is still waiting in the session's inbox."""
        texts, outcome, cursor = [], None, None
        while True:
            q = {'order': 'desc', 'limit': '50'}
            if cursor:
                q['cursor'] = cursor
            page = self.call('GET', '/api/session/%s/message?%s' % (session, urllib.parse.urlencode(q)))
            for m in page['data']:
                if m.get('id') == prompt_id:
                    return '\n'.join(reversed(texts)), outcome
                if m.get('type') == 'user':
                    texts, outcome = [], None
                elif m.get('type') == 'idle' and outcome is None:
                    outcome = m.get('outcome')
                elif m.get('type') == 'assistant':
                    texts.append('\n'.join(c['text'] for c in m.get('content') or [] if c.get('type') == 'text'))
            cursor = (page.get('cursor') or {}).get('next')
            if not cursor:
                return None
