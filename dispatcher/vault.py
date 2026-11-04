"""Short cards of vault notes, the knowledge base the triage gate correlates against."""
import re
from pathlib import Path

CLOSED = re.compile(r'^status:\s*(done|abandoned)\b', re.M)


def _summary(text, size=400):
    title = re.search(r'^# (.+)$', text, re.M)
    status = re.search(r'^## Status\s*\n+(.+?)(?:\n\n|\n## )', text, re.S)
    body = (status.group(1) if status else '').strip()
    return (title.group(1).strip() if title else ''), body[:size]


def card(vault, rel):
    path = Path(vault) / rel
    title, summary = _summary(path.read_text(encoding='utf-8', errors='replace'))
    return {'id': 'note:' + rel, 'title': title or path.stem, 'summary': summary}


def client_notes(vault, keywords, limit=12):
    """Area note of each keyword plus active project notes whose name, tags or title carry one."""
    vault = Path(vault)
    keywords = [k.lower() for k in keywords]
    found = [('02_Areas/%s/%s.md' % (k, k)) for k in keywords if (vault / '02_Areas' / k / (k + '.md')).is_file()]
    projects = []
    for path in (vault / '01_Projects').glob('*.md'):
        name = path.name.lower()
        if name.startswith(('.unison.', 'board')) or '-session-' in name:  # Unison temp files are never read
            continue
        head = path.read_text(encoding='utf-8', errors='replace')[:800]
        if CLOSED.search(head) or not any(k in name or k in head.lower() for k in keywords):
            continue
        projects.append((path.stat().st_mtime, '01_Projects/' + path.name))
    found += [rel for _, rel in sorted(projects, reverse=True)]
    return found[:limit]
