import json
import os
import re
import tomllib
from pathlib import Path

HOME = Path.home()
OPENCODE_CONFIG = HOME / '.config' / 'opencode' / 'opencode.jsonc'
OPENCODE_SERVICE = HOME / '.config' / 'opencode' / 'service.json'


def jsonc(path):
    """opencode.jsonc: whole-line // comments and trailing commas."""
    text = re.sub(r'^\s*//.*$', '', Path(path).read_text(encoding='utf-8'), flags=re.M)
    return json.loads(re.sub(r',(\s*[}\]])', r'\1', text))


def load(path):
    with open(path, 'rb') as f:
        cfg = tomllib.load(f)
    root = Path(path).resolve().parent
    cfg['db']['path'] = str(root / cfg['db']['path'])

    # The model behind the triage gate is reached the way opencode reaches it: same baseURL, key and headers.
    provider = jsonc(OPENCODE_CONFIG)['providers'][cfg['triage']['provider']]
    settings = provider.get('settings') or {}
    cfg['triage']['base_url'] = settings['baseURL'].rstrip('/')
    cfg['triage']['api_key'] = settings.get('apiKey') or ''
    cfg['triage']['headers'] = provider.get('headers') or {}

    # Sessions go to the shared opencode service unless a server is set explicitly.
    oc = cfg['opencode']
    if not oc.get('url'):
        service = json.loads(OPENCODE_SERVICE.read_text(encoding='utf-8'))
        oc['url'] = 'http://127.0.0.1:%d' % service['port']
        oc.setdefault('password', service.get('password') or '')
    oc['password'] = os.environ.get('INBOX_OPENCODE_PASSWORD', oc.get('password') or '')
    return cfg


def clients_for(cfg, account, addresses):
    """Clients whose accounts include the receiving account, else whose domains match an address."""
    clients = cfg.get('clients') or {}
    hit = [name for name, c in clients.items() if account.lower() in [a.lower() for a in c.get('accounts', [])]]
    if hit:
        return hit
    domains = {a.rsplit('@', 1)[-1].lower() for a in addresses if '@' in a}
    return [name for name, c in clients.items() if domains & {d.lower() for d in c.get('domains', [])}]
