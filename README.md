# inbox-dispatcher

Historical v1 description below. Its Python commands have been removed. TypeScript runtime documentation is scheduled for Phase 9.

Incoming Outlook mail and Teams messages (Google Chat to follow) can start work in opencode, one session per work item. The checked-in configuration currently observes sources only: incoming data is stored, automatic work is paused, and no replies are sent.

## Pipeline

1. A watcher per source talks to the source directly and prints one JSON line per message: `source`, `account`, `conversation_id`, `conversation_title`, `message_id`, `sender`, `sender_name`, `sender_is_me`, `sent_at`, `text`, `attachments`, `ref`. Outlook and Teams declare account inventory before reading folders or chats, then append a checkpoint only after complete coverage. The dispatcher persists inventory, rejects missing coverage, and passes `--since` plus known `--expected-account` values back to the watcher. Source checkpoint rows use account `*`; quiet periods retain durable progress.
2. Message identity is `(source, receiving account, native message id)`. The database's indexed `message_id` encodes `[account,native id]`; `message.native_id` retains the unmodified watcher id. A one-time transactional migration preserves existing numeric row ids, batches and drafts. Changed text or attachments under an existing account-scoped id requeue its changed version. A message from the user drops the conversation's pending draft; any other new or changed message marks it stale.
3. A conversation runs once it has been quiet for its window (`[windows]`), one run at a time. Messages arriving meanwhile form the next batch.
4. A conversation not attached to a work item goes through the triage gate: a small model on the provider opencode uses (Meridian) gets the batch, the receiving account and short vault cards of the client's notes and open work items, and answers JSON only. It has no tools. `ignore` and `fyi` stop there and stay in `triage_log` with their reason.
5. Correlation: a Jira key or pull request link shared with exactly one open work item attaches directly. Otherwise a confident `attach` attaches, and an unsure one opens a new work item with a soft link to the candidate.
6. Each work item has one opencode session on the shared server. A batch goes in as a queued turn; the `STATUS:` line and the `<<<DRAFT conversation=N ... DRAFT>>>` blocks of the reply are stored. Send, reply, forward and calendar tools are denied in the session's permissions.

## Run

```powershell
npm run inbox -- --help
```

Runtime commands require an explicit completed source-only build receipt (`--artifact`) and absolute instance configuration (`--config`). No default configuration or checkout artifact fallback exists.

Needs Classic Outlook open, Meridian on `127.0.0.1:3456`, and OpenChamber running: sessions are created on OpenChamber's own opencode server through its fixed local port, so they show up there live with OpenChamber's plugins. `[opencode] url` points the dispatcher at a plain `opencode serve` instead.

Watchers in `config.toml`:

- `outlook`: `dispatcher.watch_outlook`, every account of Classic Outlook over COM (`NewMailEx` plus a re-scan with `Items.Restrict`). Missing accounts, unreadable folders or failed item reads hold the checkpoint; `--once` fails rather than acknowledging partial coverage.
- `teams`: the `watch` subcommand of [Teams-MCP](https://github.com/Aptul9/Teams-MCP), every account the Teams desktop client holds a token for. Never restarts Teams.
- `teamsrelay`: `dispatcher.watch_teamsrelay`, read-only SQLite snapshots of owned relay stores over existing SSH access to `oe-vm`. No MCP token, deployment or chat refresh. The configured owner limits account selection. Saved history is replayed from a fixed initial source floor; SQLite deduplicates across restarts. Relay list-scan timestamps do not prove message-body completeness, so this floor does not advance with the list scan. Control lines carry a separate `observed_at` heartbeat. Catch-up retains the dispatcher's seven-day ceiling; relay text remains capped at 2000 characters and its saved-history window. Tesco is absent from the current relay inventory.

## Shadow controls

The checked-in configuration has `dispatch.enabled = false`, `mode.shadow = true`, `approval.enabled = false`, and `delivery.enabled = false`. Only a literal `dispatch.enabled = true` starts or recovers automatic work, handles approvals or archives sessions. Missing or string flags stay observe-only. Source ingestion continues independently.

Automatic work is held after a worker selected a forbidden stale corporate OneDrive workbook instead of its canonical local tracker. The nested project workflow had been omitted from candidate discovery. Recursive project discovery and canonical-path/shared-write instructions are now included on every turn. These instructions are not a filesystem sandbox. Existing user-controlled sessions retain their configured tools. Keep automatic work off until the incident and write boundaries have been reviewed.

Both an explicit `mode.shadow = false` and a literal `delivery.enabled = true` are required before any reply transport can run. Session send tools stay denied regardless of these dispatcher switches. Those mail-send gates do not govern shared document writes.

`draft N` shows exact text, receiving account and target conversation for local inspection. `reply N "Make it shorter"` records a revision request. Local CLI input cannot approve delivery. Approval comes from a direct user message in the work-item session or the configured own `48:notes` chat. Session presentation binds the actual completed assistant draft message id and timestamp, not the observer's polling time. A bare `ok` requires one unambiguous shown draft; `ok N` names one. A later text or target change invalidates consent. The self-chat account must be selected explicitly. Observation and self-chat notification remain off during shadow mode.

Delivery re-reads the source from the target conversation's original context boundary, including after revisions. New incoming messages, edits and deletion tombstones invalidate drafts; own replies drop them. A durable send-attempt marker prevents automatic retry after an unknown network outcome. Outlook receipts mean submission to Outlook, not delivery to the recipient. Live sends have not been tested during shadow mode. Relay delivery is held because a saved-store snapshot cannot prove live conversation freshness.

Only one daemon can hold a database's OS lock. `stop` requests watcher-child cleanup without interrupting the OpenCode session itself. Prompt identity and exact text are committed in `prompt_submission` before HTTP submission. Recovery reserves pending inputs before starting collectors and reconciles each work item's inputs in batch order. Unacknowledged input blocks later turns across linked conversations. Recovery checks the session timeline and inbox before replaying the same id, which OpenCode admits once. A failed CLI collection returns to `failed` with its identity retained. An allocated input is never released as a fresh source batch.

Automatic self-chat notification and `link`/`unlink`/`merge` correction commands are not implemented in this shadow runtime. Selecting the notes account remains a prerequisite for their live end-to-end checks.

## Tests

Vitest runs from a completed source-only stage with `TEST_BUILD_RECEIPT`, `INBOX_DISPATCHER_ARTIFACT` and `TEST_TRACKED_LEGACY_PATHS` supplied explicitly. The last variable is a JSON string array from the source checkout's read-only Git index, not a staged filesystem scan. Missing metadata fails closed. Full runner instructions follow in Phase 9.
