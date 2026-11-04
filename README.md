# inbox-dispatcher

Incoming Outlook mail and Teams messages (Google Chat to follow) start agent work in opencode, one session per work item. Phase 1 is shadow mode: messages are triaged, correlated and worked, replies are drafted, nothing is sent.

## Pipeline

1. A watcher per source talks to the source directly and prints one JSON line per message: `source`, `account`, `conversation_id`, `conversation_title`, `message_id`, `sender`, `sender_name`, `sender_is_me`, `sent_at`, `text`, `attachments`, `ref`. A completed scan also prints `{"source":"...","checkpoint":"<UTC time>"}` after its messages. The dispatcher owns the cursors and starts the watcher with `--since`. Source checkpoint rows use account `*`; a quiet source retains its first start across restarts.
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
.venv\Scripts\python -m dispatcher draft <draft>
.venv\Scripts\python -m dispatcher reply <draft> "ok"
.venv\Scripts\python -m dispatcher stop
```

Needs Classic Outlook open, Meridian on `127.0.0.1:3456`, and OpenChamber running: sessions are created on OpenChamber's own opencode server through its fixed local port, so they show up there live with OpenChamber's plugins. `[opencode] url` points the dispatcher at a plain `opencode serve` instead.

Watchers in `config.toml`:

- `outlook`: `dispatcher.watch_outlook`, every account of Classic Outlook over COM (`NewMailEx` plus a re-scan with `Items.Restrict`).
- `teams`: the `watch` subcommand of [Teams-MCP](https://github.com/Aptul9/Teams-MCP), every account the Teams desktop client holds a token for. Never restarts Teams.
- `teamsrelay`: `dispatcher.watch_teamsrelay`, read-only SQLite snapshots of owned relay stores over existing SSH access to `oe-vm`. No MCP token, deployment or chat refresh. The configured owner limits account selection. Every saved chat is read, including pinned chats. The relay still limits saved text to 2000 characters and history to its saved window. Tesco is absent from the current relay inventory and cannot be watched.

## Shadow controls

The checked-in configuration has `mode.shadow = true`, `approval.enabled = false`, and `delivery.enabled = false`. Both an explicit `mode.shadow = false` and a literal `delivery.enabled = true` are required before any reply transport can run. Session send tools stay denied regardless of these dispatcher switches.

`draft N` shows the exact text, receiving account and target conversation and records that local presentation. `reply N "ok"` records approval of that displayed version; other text requests a revision. A later text or target change invalidates the approval. In session or `48:notes`, a bare `ok` is accepted only when exactly one pending draft was shown there; `ok N` names a draft. The self-chat account must be configured explicitly. Observation and self-chat notification remain off during shadow mode.

Delivery re-reads the source before writing. A new incoming message marks the draft stale; an own reply drops it. A durable send-attempt marker prevents automatic retry after an unknown network outcome. Outlook receipts mean submission to Outlook, not delivery to the recipient. Live sends have not been tested during shadow mode. Relay delivery is held because a saved-store snapshot cannot prove live conversation freshness.

Only one daemon can hold a database's OS lock. `stop` requests watcher-child cleanup without interrupting the OpenCode session itself; delivered turns remain recoverable at the next start. `retry` re-collects a delivered batch instead of sending its prompt again.

## Tests

```powershell
.venv\Scripts\python -m unittest discover -s tests
```
