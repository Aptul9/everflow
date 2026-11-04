# inbox-dispatcher

Incoming Outlook mail and Teams messages (Google Chat to follow) start agent work in opencode, one session per work item. Phase 1 is shadow mode: messages are triaged, correlated and worked, replies are drafted, nothing is sent.

## Pipeline

1. A watcher per source talks to the source directly and prints one JSON line per message: `source`, `account`, `conversation_id`, `conversation_title`, `message_id`, `sender`, `sender_name`, `sender_is_me`, `sent_at`, `text`, `attachments`, `ref`. The dispatcher owns the cursors and starts the watcher with `--since`.
2. A message is stored once per `(source, message_id)` and the cursor moves in the same transaction. A message from the user drops the pending draft of its conversation; any other message marks it stale.
3. A conversation runs once it has been quiet for its window (`[windows]`), one run at a time. Messages arriving meanwhile form the next batch.
4. A conversation not attached to a work item goes through the triage gate: a small model on the provider opencode uses (Meridian) gets the batch, the receiving account and short vault cards of the client's notes and open work items, and answers JSON only. It has no tools. `ignore` and `fyi` stop there and stay in `triage_log` with their reason.
5. Correlation: a Jira key or pull request link shared with exactly one open work item attaches directly. Otherwise a confident `attach` attaches, and an unsure one opens a new work item with a soft link to the candidate.
6. Each work item has one opencode session on the shared server. A batch goes in as a queued turn; the `STATUS:` line and the `<<<DRAFT conversation=N ... DRAFT>>>` blocks of the reply are stored. Send, reply, forward and calendar tools are denied in the session's permissions.

## Run

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -m dispatcher run
.venv\Scripts\python -m dispatcher status
.venv\Scripts\python -m dispatcher retry <batch>
```

Needs Classic Outlook open, Meridian on `127.0.0.1:3456`, and OpenChamber running: sessions are created on OpenChamber's own opencode server through its fixed local port, so they show up there live with OpenChamber's plugins. `[opencode] url` points the dispatcher at a plain `opencode serve` instead.

Watchers in `config.toml`:

- `outlook`: `dispatcher.watch_outlook`, every account of Classic Outlook over COM (`NewMailEx` plus a re-scan with `Items.Restrict`).
- `teams`: the `watch` subcommand of [Teams-MCP](https://github.com/Aptul9/Teams-MCP), every account the Teams desktop client holds a token for. Never restarts Teams.
- `teamsrelay`: `dispatcher.watch_teamsrelay`, the accounts held by the teamsrelay server, through the read tools of its `/mcp` only (never `refresh_chat`, which opens the chat in Teams and marks it read). Token in `data/teamsrelay.token` (gitignored) or `INBOX_TEAMSRELAY_TOKEN`. `read_chat` returns only what the relay saved, and the relay cuts message text at 2000 characters.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests
```
