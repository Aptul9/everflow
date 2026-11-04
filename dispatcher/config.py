import json
import os
import re
import tomllib
from pathlib import Path

HOME = Path.home()
OPENCODE_CONFIG = HOME / '.config' / 'opencode' / 'opencode.jsonc'
OPENCHAMBER_SETTINGS = HOME / '.config' / 'openchamber' / 'settings.json'


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
    # Providers are tried in order; the next one takes over when one answers with a rate limit.
    providers = jsonc(OPENCODE_CONFIG)['providers']
    cfg['triage']['routes'] = []
    for name in cfg['triage']['providers']:
        settings = providers[name].get('settings') or {}
        cfg['triage']['routes'].append({'provider': name, 'base_url': settings['baseURL'].rstrip('/'),
                                        'api_key': settings.get('apiKey') or '',
                                        'headers': providers[name].get('headers') or {}})

    # Sessions go to OpenChamber's own server through its fixed local port, so they show up live there with
    # OpenChamber's plugins loaded. A url set here means a plain opencode server with basic auth instead.
    oc = cfg['opencode']
    oc['openchamber'] = not oc.get('url')
    if oc['openchamber']:
        settings = json.loads(OPENCHAMBER_SETTINGS.read_text(encoding='utf-8'))
        oc['url'] = 'http://127.0.0.1:%d' % settings['desktopLocalPort']
        oc['password'] = settings.get('desktopUiPassword') or ''
    else:
        oc['password'] = os.environ.get('INBOX_OPENCODE_PASSWORD', oc.get('password') or '')
    return cfg


def clients_for(cfg, account, addresses):
    """Clients whose accounts include the receiving account, else whose domains match the receiving account or an
    address (relay senders carry a name, not an address, so their account's domain is all there is)."""
    clients = cfg.get('clients') or {}
    hit = [name for name, c in clients.items() if account.lower() in [a.lower() for a in c.get('accounts', [])]]
    if hit:
        return hit
    domains = {a.rsplit('@', 1)[-1].lower() for a in list(addresses) + [account] if '@' in a}
    return [name for name, c in clients.items() if domains & {d.lower() for d in c.get('domains', [])}]
