"""Short cards of vault notes, the knowledge base the triage gate correlates against."""
import re
from pathlib import Path

CLOSED = re.compile(r'^status:\s*(done|abandoned|closed)\b', re.M)


def _summary(text, size=400):
    title = re.search(r'^# (.+)$', text, re.M)
    status = re.search(r'^## Status\s*\n+(.+?)(?:\n\n|\n## )', text, re.S)
    body = (status.group(1) if status else '').strip()
    return (title.group(1).strip() if title else ''), body[:size]


def card(vault, rel):
    path = Path(vault) / rel
    title, summary = _summary(path.read_text(encoding='utf-8', errors='replace'))
    return {'id': 'note:' + rel, 'title': title or path.stem, 'summary': summary}


def _head(path):
    return path.read_text(encoding='utf-8', errors='replace')[:800]


def _skipped(name):
    # Unison temp files are never read; boards and session logs are not work notes.
    return name.startswith(('.unison.', 'board')) or 'board' in name or '-session-' in name


def client_notes(vault, keywords, limit=12):
    """Area note of each keyword first, then, newest first, the other active notes of that area (tickets in
    subfolders too, `_closed` and other `_` folders left out) and active project notes carrying a keyword."""
    vault = Path(vault)
    keywords = [k.lower() for k in keywords]
    found = [('02_Areas/%s/%s.md' % (k, k)) for k in keywords if (vault / '02_Areas' / k / (k + '.md')).is_file()]
    notes = {}
    for k in keywords:
        area = vault / '02_Areas' / k
        if not area.is_dir():
            continue
        for path in area.rglob('*.md'):
            parts = path.relative_to(area).parts
            if any(p.startswith(('_', '.')) for p in parts[:-1]) or _skipped(path.name.lower()):
                continue
            rel = path.relative_to(vault).as_posix()
            if rel not in found and not CLOSED.search(_head(path)):
                notes[rel] = path.stat().st_mtime
    for path in (vault / '01_Projects').rglob('*.md'):
        name = path.name.lower()
        parts = path.relative_to(vault / '01_Projects').parts
        if _skipped(name) or any(p.startswith(('_', '.')) for p in parts[:-1]):
            continue
        rel = path.relative_to(vault).as_posix()
        head = _head(path)
        if CLOSED.search(head) or not any(k in rel.lower() or k in head.lower() for k in keywords):
            continue
        notes[rel] = path.stat().st_mtime
    found += [rel for rel, _ in sorted(notes.items(), key=lambda kv: kv[1], reverse=True)]
    return found[:limit]
