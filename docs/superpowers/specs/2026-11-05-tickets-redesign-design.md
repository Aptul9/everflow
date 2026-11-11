# Everflow v2: tickets, approval, chats

Status: approved on 2026-11-05. Stack amendment approved later the same day: all TypeScript, including watchers and CLI; Next.js, Tailwind and shadcn UI. No Python runtime or Python subprocess wrappers. Implementation plan is being revised to this amendment; all other behavioral decisions remain.

## Context

Version 1 (branch `feat/outlook-shadow-pipeline`, commit `697da99`) watches Outlook, Teams and the Teams relay, triages each quiet conversation batch with a small model, groups conversations into work items and opens one opencode session per work item at triage time. Drafts are approved in the session or in the Teams self-chat and sent by Everflow. Sending was never enabled.

On 2026-11-04 a v1 session wrote a row into a client-synced workbook copy outside its canonical workflow. The write was restored after approval on 2026-11-05. Mail-send gates did not cover file writes, and shell access is not a sandbox (vault note `everflow`, section Traps).

Target load is about 100 tickets per day across clients. On 2026-11-05 at 20:28 the Meridian quota stood at 60% of the five-hour window and 88% of the seven-day window on profile `notarify`, and at 44% of the seven-day window on profile `everbright`, before any Everflow load.

## Decisions

| Topic | Decision |
|---|---|
| Ticket | Internal ticket with lifecycle, computed stage and a timeline that carries comments, ServiceNow numbers, pull requests and similar references |
| Flow | A small agent checks the knowledge base and creates or updates a ticket. Antonio approves. Only then an OpenChamber chat is created |
| Chat permissions | After approval the chat is a normal OpenChamber chat with Antonio's tools and rules, without a deny list |
| Approval point | Overview page on localhost: Start, Open chat with a note (question or change), Dismiss. Every answer other than Dismiss creates a chat |
| Channels | No Teams, WhatsApp or similar channel for approvals or alerts |
| Processed marker | Everflow database is the queue and the processed marker for every source. Source read state is never changed |
| Approach | Evolve v1 in place with an own job layer on SQLite. DBOS rejected: its SQLite backend is positioned for prototyping and testing, waits inside versioned workflows conflict with long ticket lifetimes, and it adds `dbos` plus six dependencies |
| Implementation | TypeScript throughout the daemon, source watchers, CLI and tests. No Python runtime or Python subprocess wrappers |
| Page technology | Next.js App Router, React, Tailwind CSS and shadcn/ui. Local build and bundled assets; no external browser resources |
| Providers | Generic handling: exponential backoff on provider errors, providers tried in configured order. No quota endpoints, no autostart, no provider-specific logic |
| Supervision | Manual start and stop. The daemon runs detached from the calling process tree. No automatic restart |

## Goals

- Each message that concerns Antonio creates or updates a ticket.
- No session exists before a ticket is approved.
- One page shows tickets, sources, dependencies and failures.
- Every failure has a defined retry, a parking rule and a visible state.

## Non-goals

- Start without approval. A later version may allow it per rule; the data model keeps room for it.
- Notifications outside the page.
- Everflow writes to external trackers.
- Google Chat watcher, still blocked on OAuth.

## 1. Architecture

### Processes

- One Node.js daemon process, started with `npm run inbox -- start`, detached from the calling process tree so that a restart of OpenChamber or of a terminal does not end it. No automatic restart: Antonio starts and stops it. An OS-owned lock keeps one instance per database and is released on process exit.
- Daemon tasks: one stdout/stderr reader per watcher subprocess, ingest, scheduler (quiet batches to jobs), job runner and the Next.js server on `127.0.0.1`. A custom Node server owns startup/shutdown and validates Host before handing requests to Next.js; no standalone Next output or separate service is required.
- Watcher subprocesses: TypeScript/Node implementations of `outlook` (attach-only Classic Outlook COM), `teams` (read-only Teams token replay) and `teamsrelay` (read-only SSH snapshots). Port the existing source semantics; do not invoke the Python implementations. The daemon timestamps their stderr lines and feeds them into source health.
- External dependencies: the model providers configured in opencode (Meridian today) for the triage agent and the chats, the OpenChamber opencode server for the chats, the vault as read-only knowledge base for the triage agent. No provider-specific logic.

### Modules

| Module | Status | Role |
|---|---|---|
| `src/watchers/*.ts`, `src/windows/*.ts` | port | Read-only sources and native Windows bridges; no desktop launch/restart fallback and no Python bridge |
| `src/core/db.ts` | new | SQLite schema v2 and migration preserving cursors, conversations and messages |
| `src/core/ingest.ts`, `src/cli.ts`, `src/core/runtime.ts` | new | Ingest/batching semantics, manual detached start/stop, `ticket show/merge/relink/close`, `job list/retry/park`, `quarantine replay` |
| `src/core/opencode.ts` | new | Typed OpenCode transport, tag lookup, structured turn errors and stage rename; no deny list |
| `src/core/jobs.ts` | new | `enqueue(kind, key, payload)`, leases, attempts, backoff, parking, per-ticket ordering, concurrency and dependency health |
| `src/core/kb-agent.ts` | new | Small-model read-only vault tool loop and validated structured decision |
| `src/core/tickets.ts` | new | Ticket lifecycle, timeline, references, computed stage and ordered linking rules |
| `src/core/chat.ts` | new | Approved chat creation, briefs/forwards, collection, STATUS, recovery, sync and archive |
| `src/app`, `src/components`, `src/server.ts` | new | Next.js route handlers and React overview using Tailwind/shadcn; localhost server lifecycle |
| `src/core/vault.ts`, `src/core/config.ts` | new | Read-only vault tools, TOML configuration and shared typed contracts |
| `dispatcher/*.py`, Python runtime/tests/requirements, draft/consent/send tables, `draft` and `reply` CLI, DRAFT parsing | delete after port coverage | No Python in the final application. Chats send on their own after Antonio's yes in chat |

### Trust boundaries

- Triage agent: no write tools. Message text is data. Its decisions only create or update tickets.
- Chat: normal OpenChamber chat with Antonio's tools and rules, no deny list. The brief keeps one line: never start, focus or close a desktop app.
- Page: answers on `127.0.0.1` only and checks the Host header. Its POST actions require a token generated at each daemon start.

### Rollout switches

`[tickets] enabled` lets the triage agent create tickets and the page show them. `[chats] enabled` lets Start and Open chat create chats; while it is off the buttons read "chats off". The two switches replace `mode.shadow`, `dispatch`, `approval` and `delivery`.

## 2. Data model

### Tables

| Table | Key fields | Notes |
|---|---|---|
| `ticket` | `title`, `client`, `summary`, `ask` (what is expected of us), `proposal` (what Start will do), `lifecycle` (`proposed` `active` `done` `dismissed`), `session_id`, `report` (`working` `needs_you` `waiting_them` `blocked` `done` and one line), `kb_notes`, `confidence`, `created_at`, `approved_at`, `closed_at` | Lifecycle is stored, the displayed stage is computed |
| `ticket_conversation` | `ticket`, `conversation`, `kind` (`primary` `linked` `context`), `by` (`rule` `agent` `you` `chat`) | `primary` and `linked` route the conversation's messages to the ticket and its chat. `context` only shows |
| `ticket_ref` | `ticket`, `kind` (jira, snow, github_pr, gitlab_mr, ado_pr), `key`, `url`, `seen_in` (message or chat) | Unique per kind, key and ticket. Drives linking rule 2 |
| `timeline` | `ticket`, `at`, `kind` (`message` `triage` `ref` `status` `comment` `approval` `chat` `failure` `merge`), `actor`, `body`, `link` | Ticket history on the page |
| `job` | `kind`, `key` (unique), `ticket`, `payload`, `state` (`queued` `running` `done` `parked` `cancelled`), `attempts`, `next_at`, `lease_until`, `error_class`, `last_error` | Section 4 |
| `turn` | `ticket`, `kind` (`brief` `forward` `recovery` `note`), `batch`, `prompt_id` (unique), `text`, `state`, `outcome` | Successor of `prompt_submission`. Identity and text are committed before the HTTP call |
| `health` | `dependency`, `state`, `since`, `last_ok`, `last_error`, `detail` | Rows for the daemon heartbeat, outlook, teams per account, teamsrelay, each provider, openchamber |
| `quarantine` | `source`, `line` (first 4 KB), `error`, `at` | Watcher lines that failed validation |
| kept | `cursor`, `conversation`, `person`, `message`, `batch`, `triage_log` | `batch` gains `outcome` and `ticket` |
| dropped | `draft`, `approval_request`, `approval_event`, `send_attempt`, `work_item`, `work_item_conversation`, `prompt_submission` | The v1 database file is backed up first |

### Displayed stage

The first matching row wins.

1. Failed: the ticket has a parked job.
2. Needs you: lifecycle `proposed`, or report `needs_you` or `blocked`.
3. Working: a queued or running job for the ticket, or a chat turn in progress.
4. Waiting on them: report `waiting_them`.
5. Idle: lifecycle `active` and none of the above.
6. Done or Dismissed: from the lifecycle.

### Linking rules

Applied in order to each new batch.

1. The conversation already routes to a ticket. `proposed` or `active`: the batch updates that ticket. `done` within the last 14 days: the ticket reopens and the batch goes to its chat. `dismissed`: the batch is handled as new, and the old ticket is linked as context.
2. A reference shared with exactly one open ticket (Jira key, ServiceNow number, PR or MR link): the conversation is linked by rule.
3. The triage agent picks among open tickets of the same client, tickets that share people with the batch, and tickets of the last 14 days. `update N` with confidence 0.75 or higher links the conversation; a lower confidence creates a new proposed ticket shown as "maybe #N".
4. Otherwise: a batch that is on us creates a proposed ticket. A batch that is not on us gets outcome `not_on_us`, stays in `triage_log`, and appears on the page under Skipped.

Corrections run through `npm run inbox -- --config PATH ticket relink|merge|close`, by Antonio or by the chat. The brief supplies the absolute repository/config/interpreter paths, so scratch chats never fall back to the held live database. Each correction writes a timeline entry.

### People

Matching a Teams oid with a mail address needs a lookup that Teams-MCP does not offer today. It is listed among the checks before code (Teams profile API). Until it exists, people match within one source only.

### Migration

The v1 database file is backed up. Source tables and `triage_log` are kept. Tickets start empty.

Messages ingested before `[start] triage_after` (default: the time of the first v2 start) get a batch with outcome `backlog`. They are not triaged and appear under Skipped, where Make ticket turns any of them into a ticket. On 2026-11-05 the v1 database held 551 messages without a batch, sent between 05:01 and 18:04 UTC, in 73 conversations with messages from others: without this rule the first start would propose up to 73 tickets for day-old messages.

### Retention

A job deletes the message text of `not_on_us` batches older than 30 days.

## 3. Flow

1. Ingest. A watcher line is stored together with its cursor in one transaction. Unchanged.
2. Batch. After the quiet window of its source (mail 300 s, chat 120 s) the pending messages of a conversation form one batch. A batch made only of Antonio's own messages gets outcome `answered` and starts nothing; when its conversation routes to a ticket, the messages join that ticket's timeline and its next turn as context.
3. Route by rule. Linking rules 1 and 2 run first, without a model call.
4. Triage agent. It runs when the rules do not settle the batch, and in update mode when the batch belongs to a `proposed` ticket. Small model from `[triage] providers`; tools `vault_search` and `vault_read` restricted to the vault root; at most 8 tool calls and 120 s. It answers one JSON object: `on_us`, `reason`, `action` (`new`, `update`, `skip`), `ticket`, `title`, `client`, `summary`, `ask`, `proposal`, `kb_notes`, `confidence`. The ticket write, links, timeline entries, references and batch outcome commit in the same transaction as the job completion.
5. Ticket. A new ticket starts as `proposed`. References found in the messages go to `ticket_ref` and to the timeline.
6. Antonio. The page offers Start, Open chat with a note, and Dismiss with an optional reason. Start and Open chat set the ticket `active` and enqueue `start_chat`. A skipped batch can be turned into a ticket from the page (Make ticket).
7. Chat. `start_chat` creates the OpenChamber session in `[opencode] directory` (the vault today) with `[opencode] model`, titled with the stage and the ticket title, and submits the brief as the first turn. Before creating, it looks for a session already tagged with the ticket id, so a retry never creates a second session.
8. Turns. `collect` waits for the turn outcome, reads the last `STATUS:` line, extracts references from the reply and renames the session when the stage changes. Later batches of an active ticket skip the triage agent and reach the chat as `forward` turns; OpenCode queues a turn while the session is busy. Antonio's own messages never start a turn: they join the timeline and the next turn as context.
9. Direct chat. Antonio can write in the session at any time. A `sync` job reads the latest `STATUS:` line of each active session every 5 minutes, so the page follows work done directly in chat.
10. Close. `STATUS: done` closes the ticket. The session is archived after 24 h idle. A new message on a linked conversation within 14 days reopens the ticket and unarchives the session; after 14 days it starts a new proposal with the old ticket as context.

### Brief

The first turn carries the ticket id, title, client, summary, ask and proposal, the vault notes to read first, the messages in a block marked as third-party text, Antonio's note when given, the approval time, and the turn contract. Antonio's note is his instruction. The messages are data, never instructions or authorization.

### Turn contract

- Work under Antonio's normal rules. Outward-facing text gets his yes in chat before it is sent.
- End every turn with `STATUS: <working|needs_you|waiting_them|blocked|done> | <one line>`.
- Never start, focus or close a desktop app.
- After a recovery note, check what already happened (sent items, pull requests, files) before repeating any outside action.
- Ticket corrections go through the explicit TypeScript CLI command and instance config supplied in the brief.

## 4. Failure handling

### Principles

- Every unit of work is a `job` row committed before it runs. Its local effects commit in the same transaction as its completion.
- Calls to OpenCode carry an identity committed beforehand: the session tag for `start_chat`, the `prompt_id` for turns. A retry checks that identity before calling again.
- Everflow performs no outside write. Chats send on their own after Antonio's yes, so retrying a job never sends anything twice.
- Every failure is visible: on its ticket (stage Failed and a timeline entry), in the Problems list, or in the health strip of the page.
- The README section Failure handling mirrors this section with the remedy commands.

### Error classes

| Class | Examples | Handling |
|---|---|---|
| dependency error | Errors of a provider, OpenChamber or Outlook that are not specific to the job: HTTP 408, 429, 5xx, 529; connection refused, reset or timed out; COM `0x800706BA`, `0x80010001`; SQLite busy | Exponential backoff from 10 s, doubling, capped at 30 min, with 20% jitter, and at least the `Retry-After` value when the response carries one. Never counted as an attempt, never parks |
| job error | Triage answer still invalid after one repair turn; HTTP 400 or 403; 401 after a fresh sign-in; 404 on a session; programming errors | Parked at once |
| unknown | Anything else | Same backoff, counted as an attempt, parked after 5 |

### Job policies

| Job | Key | When it parks |
|---|---|---|
| `triage` | `triage:batch:<id>` | The batch keeps its messages, and later messages of the conversation join it. Page: Problems |
| `start_chat` | `start:ticket:<id>` | Ticket Failed |
| `forward` | `forward:ticket:<id>:<seq>` | Ticket Failed. Later forwards of the ticket merge into it, so the chat never receives a later batch without an earlier one |
| `collect` | `collect:turn:<id>` | Polls every 10 s until the turn ends. A turn failed by a dependency error gets a recovery turn after backoff. A turn failed otherwise gets at most 2 recovery turns in a row, then parks |
| `sync`, `archive`, `purge` | Per ticket, per day | Never parks; failures show as health |

All numbers live in `[jobs]` in `config.toml`.

### Concurrency

At most 3 `triage` jobs run at a time, as today. At most 4 chat turns (`start_chat`, `forward`, recovery turns) are in flight across all tickets. `collect` and `sync` only poll and have no limit. Both limits live in `[jobs]`.

### Ordering

Jobs of one ticket run one at a time, in enqueue order. A parked job holds back the later jobs of its ticket. `job retry` or the page Retry action re-queues it with attempts reset.

### Leases and restarts

A running job holds a lease of 120 s, renewed every 30 s. Each daemon start has its own run id. At start, jobs whose lease expired return to the queue. An admitted turn is collected again and never resubmitted. A turn cut off by a restart of the daemon or of OpenChamber gets a recovery turn: "host restarted at HH:MM; check sent items, pull requests and files before repeating any outside action".

### Dependencies

Each job kind names the dependencies it calls: provider ids, `openchamber`, `outlook`. A dependency with 3 consecutive errors shows as failing on the page from its first error; one success clears it. Its jobs keep backing off meanwhile.

### Providers

Triage tries the providers of `[triage] providers` in order and moves to the next one on a dependency error. Chats keep the model they were created with. There is no provider-specific logic: no quota endpoints, no autostart. The Meridian autostart in today's `triage.py` is removed.

### Sources

| Source | Processed marker | Failure | Read state |
|---|---|---|---|
| Outlook | Message row and cursor in one transaction; checkpoint only after every account and folder was read | Cursor holds; the next scan restarts from it with 2 minutes of overlap; duplicates are dropped by account and Internet message id | Never changed |
| Teams | Same; checkpoint requires every known account | Cursor holds for the account that failed | Never changed: marking read sends Seen to the sender |
| Teams relay | Fixed replay floor and deduplication | Snapshot read again at the next poll | Not writable |

A watcher line that fails validation goes to the `quarantine` table instead of being dropped. `Everflow quarantine replay` re-ingests it after a fix.

### Supervision and logs

- `npm run inbox -- start` launches the built Node daemon detached from the calling process tree. Antonio starts and stops it; there is no automatic restart. `npm run inbox -- stop` stops it gracefully. Tests always pass an explicit scratch config.
- The daemon writes a heartbeat to `health` every 10 s. The page shows it; an open tab shows "Everflow unreachable since HH:MM" when requests fail.
- Watcher stderr is read through a pipe and logged with a timestamp and the source name. Error lines update the source's health.
- Log rotation at 10 MB, 5 files.

### Scenarios

| Event | Result |
|---|---|
| Daemon killed or crashed | It stays down until started again; open tabs show unreachable since HH:MM. At the next start, expired leases re-queue, admitted turns are collected, the others are reconciled by prompt id |
| OpenChamber restarts during a turn | OpenChamber shows as failing and its jobs back off. On return the failed turn gets a recovery turn |
| Provider rate limit or outage | Backoff up to 30 min until it answers. Triage moves to the next provider. The page shows the provider failing since its first error |
| Outlook closed | Outlook row red with the time since. Cursor holds. No job affected |
| Teams certificate error on every account | Each account row red from its first error. Checkpoint holds. Messages are read once the error clears |
| Triage answer invalid | One repair turn with the parse error, then parked with the raw answer on the page |
| Message linked to the wrong ticket | The chat or Antonio runs `ticket relink`. The timeline records it |

## 5. Overview page

### Server

- A custom TypeScript Node HTTP server owns the Next.js request handler on `127.0.0.1`, port from `[web] port`. Next.js App Router route handlers perform only local reads/actions. The daemon owns the per-start token and instance config; no global/server autostart hook is installed.
- A request whose Host header is not `127.0.0.1:<port>` or `localhost:<port>` gets 403, which blocks DNS rebinding.
- `GET /` dynamically renders the Next.js page with the current daemon-start token supplied to the client UI. `GET /api/state` returns tickets grouped by stage, health, problems and skipped batches, with an ETag. `GET /api/ticket/<id>` returns timeline, messages and references.
- POST actions require the header `X-Token` and a same-origin `Origin`: `/api/ticket/<id>/start`, `/api/ticket/<id>/chat` with the note, `/api/ticket/<id>/dismiss` with the reason, `/api/batch/<id>/ticket` (Make ticket), `/api/job/<id>/retry`. Each action writes a timeline entry and enqueues its job; the request does no other work.
- No CORS headers.

### Page

- Next.js React components, Tailwind CSS and shadcn/ui, with locally bundled scripts/styles/icons and system fonts. No external browser resources. Framework build output is generated; source edits land in TypeScript/TSX/CSS.
- Header: daemon heartbeat, sources (Outlook, each Teams account, relay), OpenChamber and providers, each with state and time since.
- Problems line: parked jobs with error and Retry, quarantined lines, triage failures.
- Tabs with counts: Needs you, Working, Waiting on them, Failed, Done today, Skipped. Proposed tickets come first in Needs you. Working lists the stages Working and Idle; idle tickets carry the label idle.
- Proposed card: client, title, age, confidence, "maybe #N", ask, proposal, vault notes, references, messages on demand; actions Start, Open chat with a note, Dismiss with a reason. Selected cards can be dismissed together.
- Active card: stage, last `STATUS:` line, references, and the session title to find it in OpenChamber.
- Ticket detail: timeline, newest first.
- Keyboard: `j` and `k` move, `s` Start, `c` note and Open chat, `d` Dismiss, `/` search.
- Refresh: `/api/state` every 10 s with `If-None-Match`. On failure the page keeps the last state and shows "Everflow unreachable since HH:MM".
- Message text is third-party content and is always rendered through React's text escaping, never as HTML. Application code never uses `dangerouslySetInnerHTML` or raw DOM HTML insertion for source/model content.

### Out of scope

Phone access, notifications, and approval of outward text, which stays in the chat.

## 6. Testing, checks before code, rollout

### Tests

Stack amendment: the v2 suite uses TypeScript/Vitest (`npm test -- --run`), React Testing Library for client components and real Next.js HTTP/browser checks for async server components. Port the existing behavior contracts; no Python runner is part of v2. Each phase remains test-first and green before the next.

| Area | Tests |
|---|---|
| Job layer | One job per key; lease claim and expiry; dependency errors never count and never park; job errors park at once; unknown errors park after 5; backoff bounds with jitter and the `Retry-After` floor; one running job per ticket; a parked job holds later jobs; forward merging; retry resets attempts |
| Crash points | A crash injected at every step boundary of every job kind, followed by a restart on the same database. After each restart: one session per ticket, one admitted turn per `prompt_id`, every message either pending or in a batch with an outcome, every ticket in a valid lifecycle |
| Linking | Rules 1 to 4 for every lifecycle, a reference shared by one and by two open tickets, the 0.75 threshold |
| References | Jira keys; ServiceNow INC, CHG, RITM, TASK; GitHub and ADO pull requests; GitLab merge requests; the existing exclusion list |
| Triage agent | Scripted model: tool loop, step cap, timeout, vault path escapes rejected (`..`, absolute paths, links), invalid JSON with one repair, instructions injected in messages leave the answer schema unchanged |
| Chat | Brief contents and the third-party block, `STATUS:` parsing including malformed lines, stage rename, recovery turn text, own messages that start no turn, reopening within and after 14 days |
| Page | Host check before Next routing, token and Origin on every POST, JSON shape, React text escaping, no application raw-HTML insertion, client interactions and actual Next.js HTTP/browser behavior |
| Migration | A v1 fixture database migrates with cursors, conversations, messages and `triage_log` intact; the backup file exists |
| Watchers | Stderr lines timestamped and mapped to health; quarantine and replay |

Port the source/runtime contracts of `test_outlook.py`, `test_relay_store.py`, `test_relay_replay.py`, `test_runtime.py`, `test_daemon.py` to TypeScript, and rewrite pipeline/recovery/triage contracts for v2. Delete Python code/tests after their retained contracts pass in Vitest. Approval/channel/draft/send contracts are removed. Historical v1 schema remains a SQL migration fixture, not an executable Python dependency.

### Live checks before done

- Scratch copy of the live database, real sources, `[chats] enabled = false`: real mail and chat messages produce tickets, and the page shows them.
- A provider entry that refuses connections, placed first in `[triage] providers`: triage backs off on it, moves to the next provider, and the page shows it failing.
- One real chat on a harmless ticket: session created, brief visible, `STATUS:` collected, title renamed.
- The same chat with its turn aborted through the API: one recovery turn, no duplicate session or prompt.
- Daemon killed during a turn and started again: the turn is collected and nothing is resubmitted.

### Checks before code

| Check | Method | Passes when |
|---|---|---|
| Detached start | An inert Node launch probe before code; actual scratch `npm run inbox -- start` after CLI exists. Inspect parent chain and `IsProcessInJob` | Node process is outside OpenChamber's process tree and job object; final command-level proof is recorded separately |
| Session tag lookup | Create a session with `metadata.everflow.ticket`, then list sessions through the API | The tag comes back and identifies the session |
| Title rename | `PATCH /api/session/{id}` with a title after the first turn | The title stays; OpenChamber's session-title plugin does not overwrite it |
| Instructions in API sessions | First turn of an API-created session asks which instruction files are loaded | The session carries the same instructions as a session opened in OpenChamber |
| Failed turn detail | A turn that fails on a refused provider | The timeline shows an error with a status or type, enough to classify it |
| Turn abort | Abort a running turn through the API | The outcome is readable and a new turn runs afterwards |
| Tool use through the provider | Small-model request with two tools through the configured provider | The `tool_use` round trip completes |
| Teams people lookup | Resolve one sender oid to a mail address with the Teams token | A mail address comes back; otherwise people stay matched within one source |
| OpenChamber link | Look for a URL that opens a given session | Found: the page links to it. Not found: the page shows the session title |

Results go to the vault project page, section Pre-code checks, as on 2026-11-04.

The all-TypeScript amendment also requires native-source feasibility before application code: attach-only Outlook COM with no creation fallback, Teams cookie/DPAPI access without Python or restarting Teams, and relay snapshots without executing remote Python. Native libraries are allowed; application source, watchers and subprocess entry points are TypeScript/compiled JavaScript. Record these bridge results alongside the nine checks. A failed bridge is a blocker, never a silent Python or desktop-restart fallback.

### Rollout

1. Checks before code, recorded in the vault.
2. Work on branch `feat/tickets-v2`, cut from the current head of `feat/outlook-shadow-pipeline`. The merge order with PR 1 is set in the implementation plan.
3. Tests green and live checks passed.
4. Review period with `[tickets] enabled = true` and `[chats] enabled = false`. Proposals appear on the page; Dismiss reasons and Make ticket count as feedback, and the page shows both counts. The period ends on Antonio's call.
5. `[chats] enabled = true`.
6. Once v2 runs: README rewritten for operation (start, stop, page, failure handling with remedies). The v1 proof files under `data/` are deleted after Antonio confirms; the v1 database backups stay.

Outside v2: automatic start for a kind of ticket, beginning with the Azure notice workflow, whose vault note grants standing autonomy since 2026-07-21.

## Prior art

| Piece | Prior art | Taken | Left out |
|---|---|---|---|
| Whole system | [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype), docs 001 to 003 | Ticket with mandate, stage computed from stored facts, attention as structured state, documented retry and failure rules | GitHub and Feishu only, replies as its own bot |
| Whole system | [agents-from-scratch](https://github.com/langchain-ai/agents-from-scratch), [Agent Inbox](https://github.com/langchain-ai/agent-inbox) | Triage into ignore, notify, respond; human actions accept, edit, respond, ignore | LangGraph platform |
| Whole system | [Inbox Zero](https://github.com/elie222/inbox-zero) | Draft-first, plain-language rules, reply tracking | Cloud mail APIs, Postgres and Redis, no Teams |
| Ticket threading | [Zendesk](https://support.zendesk.com/hc/en-us/articles/8396827889946), Zammad | References and In-Reply-To headers, ticket number in subject or body | Helpdesk UI |
| Durable execution | [DBOS Python](https://github.com/dbos-inc/dbos-transact-py), [Temporal](https://docs.temporal.io/ai/cookbook/human-in-the-loop-python) | Idempotent steps, leases, retries with backoff, parking | Library and server |
| Approvals | [opencode v2 permissions](https://opencode.ai/v2/docs/permissions), n8n send and wait | Approve, revise with a note, reject | Tool-level ask: OpenChamber answers it automatically (`permissionDefaultMode: "auto"`), see [opencode #56470](https://github.com/anomalyco/opencode/issues/56470) |
| Failures | [Idempotent consumer](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), dead-letter queue with owner and replay | Error classes, parking, replay command, failing state after three errors in a row | Message broker |
| Read state | Outlook UnRead and Categories, Teams read receipts, [Google Chat read state](https://developers.google.com/workspace/chat/update-space-read-state) | Nothing | Read state as queue |
