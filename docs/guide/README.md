# Inbox dispatcher: from message to ticket and chat

How the inbox dispatcher collects mail and chat messages, proposes tickets on a local page, and runs an approved ticket in an OpenChamber chat.

- `inbox-dispatcher.docx`: the document for reading.
- `inbox-dispatcher.md`: the same text in Markdown, and the source of the Word file.
- `build.py`: builds the Word file from the Markdown.
- `diagrams/`: the pictures and their sources.

The text is read on 2026-11-06 from the branch `feat/triage-history` at `ff8373a`, which adds the earlier messages sent to triage on top of `feat/tickets-v2` at `387d402`, and from the instance folder `%LOCALAPPDATA%\inbox-dispatcher-v2`: its `config.toml` and its four `.ps1` scripts. The database, its sidecars, the log and the relay token are left out on purpose. Client names, accounts and hosts are left out of the text and the pictures. The page is not described in detail, because its layout is being redesigned on `feat/ticket-page-redesign`.

## Building the Word file

```bash
python build.py
```

The script is the one of `note/archs/proxy` in the Notarify documentation, with two changes: it reads `inbox-dispatcher.md` instead of the Markdown file named after its folder, and the header carries `inbox-dispatcher` instead of the company name. It needs python-docx, pillow and pywin32, plus Word. The Word file has to be closed while it runs. The document has no Mermaid block: the two pictures and the tables carry the flow.

## Diagrams

`inbox-dispatcher-architecture` shows the watchers, the database and job queue, triage, the page, the chat and the collector. `inbox-dispatcher-at-a-glance` shows one Teams message over time. The JSON files are the sources of the HTML pages and of the PNGs. From `diagrams/` in Git Bash:

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture inbox-dispatcher-architecture.json inbox-dispatcher-architecture.html --quality showcase
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1400,880 --screenshot="$(pwd -W)/inbox-dispatcher-architecture.png" "file:///$(pwd -W)/inbox-dispatcher-architecture.html?embed=1&theme=light"
```

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver sequence inbox-dispatcher-at-a-glance.sequence.json inbox-dispatcher-at-a-glance.html --quality showcase
node ~/.claude/skills/archify/bin/archify.mjs visual-check inbox-dispatcher-at-a-glance.html --json
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1400,820 --screenshot="$(pwd -W)/inbox-dispatcher-at-a-glance.png" "file:///$(pwd -W)/inbox-dispatcher-at-a-glance.html?embed=1&theme=light"
```

The screenshot path has to be absolute, because a relative one fails with an access error. `visual-check` writes its evidence files next to the page, and they can be deleted once it reports a pass.

In the architecture the label of the Teams line has a fixed `labelAt`, because the Outlook and relay lines join it at the left side of SQLite and the default place sits on their shared vertical. The label of the page line has one too, because by default it sits inside the page box.
