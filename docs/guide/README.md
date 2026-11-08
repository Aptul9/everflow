# Workdesk: from message to ticket and chat

Reader guide for source collection, local ticket proposals and approved OpenChamber work.

- `workdesk.md`: document source.
- `workdesk.docx`: generated Word document.
- `build.py`: existing Word generator, renamed inputs and header.
- `diagrams/`: typed JSON sources and generated HTML/PNG diagrams.

Guide updated 2026-11-07 from current TypeScript source. Covers Outlook, Teams, relay, Google Chat through gweb and Gmail through gws. Existing instance paths remain unchanged. No database, sidecar, log, relay token or source credential is included in the guide build. Account and client names remain outside the document and diagrams.

## Generate diagrams

Run from the checkout. The architecture groups the two mail watchers and the two direct chat watchers into paired nodes; each remains a separate runtime source. The sequence follows one Teams message and retains its 120-second quiet window.

```powershell
node "$env:USERPROFILE/.claude/skills/archify/bin/archify.mjs" deliver architecture docs/guide/diagrams/workdesk-architecture.json docs/guide/diagrams/workdesk-architecture.html --quality showcase --json
node "$env:USERPROFILE/.claude/skills/archify/bin/archify.mjs" deliver sequence docs/guide/diagrams/workdesk-at-a-glance.sequence.json docs/guide/diagrams/workdesk-at-a-glance.html --quality showcase --json
```

The HTML files are generated. Edit JSON and regenerate. Diagram PNGs use the same delivered HTML, light theme and `embed=1`, with Chrome headless at 2x scale. Architecture viewport: 1400x880; sequence viewport: 1400x820. Screenshot paths must be absolute. The architecture retains existing diagnosed label positions where routes share a corridor.

## Generate Word

Run from this folder after regenerating the PNGs:

```powershell
python build.py
```

Requires python-docx, Pillow, pywin32 and Word. The document must be closed. Word runs hidden to update the real contents field and page numbers. Existing formatting and generator are retained. Application watchers, runtime and tests remain TypeScript; this Python script is documentation tooling only.

## Compatibility

Product, repository, checkout, environment variables (`WORKDESK_*`) and named-pipe locks use the name Workdesk. The retained weekend instance `%LOCALAPPDATA%/inbox-dispatcher-v2` keeps its folder name. No instance migration or source activation is part of documentation generation.
