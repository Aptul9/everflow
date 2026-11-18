# Everflow

TypeScript inbox collection, local ticket proposals and approved OpenChamber chats. SQLite holds the queue and processed markers. Source read state is never changed. Everflow has no mail or chat send transport and no channel-based approvals or alerts.

The name Everflow covers the GitHub repository, the checkout, `EVERFLOW_*` environment variables, named-pipe locks, OpenChamber session tags and build and scratch paths. `npm run everflow -- --help` is the only launcher. A build made before the last rename keeps its own names and paths, so it does not run against a renamed instance folder: rebuild instead. Chats created by such a build carry an older session tag; their session ids stay on the ticket, only the lost-create recovery lookup misses them. No database migration is required.

Tickets and chats are disabled by default. Source collection has its own switches. Implementation and synthetic tests do not authorize live migration, source activation or chat activation.

## Prerequisites

- Windows x64 or Linux x64, and Node.js `26.4.0`, including its npm distribution. The lockfile pins TypeScript `7.0.2`, Next.js `16.4.5`, `koffi` `3.3.7` and `winax` `3.6.10` (optional, Windows only). On Linux the Outlook and Teams desktop sources are unavailable; relay, OE mail, Google and Slack sources run, see Linux host (oe-vm) below.
- On Windows, MSVC C++ build tools with a Windows SDK. The recorded toolchain uses Visual Studio 2026 Build Tools. Native compilation also requires a node-gyp-compatible Python interpreter. It is build tooling only. The application, watchers, CLI and tests use TypeScript/Node.
- Network access to the lockfile's dependency downloads during the private build. Source-specific access is separate and unnecessary for the disabled synthetic instance below.
- For live triage, an explicit read-only knowledge-base root, model and ordered provider ids in `[triage]`. Provider routes come from `triage.provider_config_path` or the existing OpenCode JSONC settings. No provider is installed, started or selected automatically.
- For approved chats, an already running OpenChamber server and its existing settings. An empty `opencode.url` reads `~/.config/openchamber/settings.json` for `desktopLocalPort` and `desktopUiPassword`. An explicit HTTP(S) `opencode.url` uses that server instead, with optional `EVERFLOW_OPENCODE_PASSWORD`. `opencode.directory` identifies the session directory. A nonempty model uses `provider/model` form.

Everflow never starts, focuses, closes or restarts Outlook, Teams or providers. Google Chat has an explicit opt-in for minimized authentication bootstrap. Provider quota endpoints, provider lifecycle helpers and daemon autostart are absent. Source prerequisites are described below.

## Build

Run from the source checkout with the pinned Node version:

```powershell
npm run build
```

This is the clean setup and production-build command. No checkout dependency installation or standalone setup is required first. The dependency-free controller in [scripts/build.ts](scripts/build.ts) creates a fresh source-only stage. It runs private `npm ci --include=dev --foreground-scripts --no-audit --no-fund`, native verification, Next.js production compilation and server compilation there.

The build supplies only named root inputs, including this README, and approved TypeScript/TSX/CSS source and the historical SQL test fixture. It excludes the default instance configuration, environment files, Git metadata, documentation trees, databases and user state. Source links, junctions and hard links are rejected. Dependency links and output traces must remain inside the stage. Project, Turbopack and tracing roots are pinned to that stage.

Dependencies, npm configuration, profile, cache, node-gyp headers and temporary files are private to the stage. Build output lives under `C:/Users/Antonio/AppData/Local/Temp/opencode/everflow/source-builds` on Windows and `~/.local/share/everflow/source-builds` of the building account on Linux (home from the user database, not `$HOME`), as declared in [build-artifact.ts](src/web/build-artifact.ts). The native verification step runs on Windows only. The final JSON line contains `buildReceipt`, an absolute path to a completed `build-receipt.json`. A prepared stage is not a runnable artifact.

No checkout `dist` or `.next` is required. Do not invoke Next.js directly in the checkout. Staging is not an OS sandbox or a complete filesystem/network audit.

## Daily use

`scripts/everflow.ps1` drives one instance folder, by default `%LOCALAPPDATA%\everflow`, which holds `config.toml`, the database and `build.txt`. `build` runs `npm run build` in this checkout and writes the new receipt path to `build.txt`; no other step selects a build. `start`, `stop` and `status` call the pinned build's CLI with that config, and `open` opens the page of the running instance. `-Instance <folder>` selects another instance folder.

```powershell
.\scripts\everflow.ps1 build
.\scripts\everflow.ps1 start
.\scripts\everflow.ps1 open
.\scripts\everflow.ps1 stop
```

A rebuilt instance uses the new build after `stop` and `start`.

## Select an artifact

Keep one completed receipt selected explicitly. Never select the newest directory or fall back to checkout output. These PowerShell bindings create a new synthetic instance directory only:

```powershell
$source = Read-Host 'Absolute source checkout path, not the staged root'
$receipt = Read-Host 'Absolute completed buildReceipt path from npm run build'
$build = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
if ($build.status -ne 'complete') { throw 'Completed build receipt required' }
$cli = Join-Path $build.root 'dist/cli.js'
$scratch = Join-Path $env:LOCALAPPDATA ('Temp/opencode/everflow/manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch -ErrorAction Stop | Out-Null
$config = Join-Path $scratch 'config.toml'
```

Both receipt and config paths passed to the CLI must be absolute. Every non-help command validates a completed artifact before opening the explicit instance config. `EVERFLOW_ARTIFACT` is an alternative explicit receipt input; examples retain `--artifact` on each command. The checkout package launcher forwards to the selected compiled CLI. No default config or artifact fallback exists.

## Disabled instance

Save this TOML as `$config` in the newly created scratch directory. Relative DB, vault and session-directory paths resolve beside that config, never beside the checkout. This instance enables no source, provider or chat operation.

```toml
[db]
path = "fixture.db"

[vault]
path = "kb"

[tickets]
enabled = false

[chats]
enabled = false

[sources.outlook]
enabled = false

[sources.teams]
enabled = false

[sources.teamsrelay]
enabled = false

[sources.gchat]
enabled = false

[sources.gmail]
enabled = false
```

Only a literal TOML `true` enables tickets or chats. Missing switches, strings such as `"true"` and other values stay disabled. Configuration is loaded at startup. A changed file requires a manual restart to take effect. The old shadow, dispatch, approval, delivery and watcher-command settings are ignored by [config.ts](src/core/config.ts).

## CLI help

```powershell
& node $cli --help
```

Help opens no config or database. Use the compiled help for supported command arguments. All examples below keep the selected receipt and absolute scratch config.

## Native verification

The builder calls [scripts/setup.ts](scripts/setup.ts) with `--verify-only` after installation. Its child-scoped no-LTO environment is:

```json
{
  "npm_package_config_node_gyp_enable_thin_lto": "false",
  "npm_package_config_node_gyp_enable_lto": "false",
  "npm_package_config_node_gyp_lto_jobs": ""
}
```

Verification requires generated winax settings `clang: 0`, both LTO settings `"false"` and empty `lto_jobs`, then loads the pinned native modules. No global compiler patch or package change is required. Optional re-verification of the selected artifact writes its log to the owned scratch directory:

```powershell
& node (Join-Path $build.root 'scripts/setup.ts') --verify-only --log (Join-Path $scratch 'native-verify.log')
```

`--verify-only` and `--log` are setup-script flags, not build or Everflow flags. Without `--verify-only`, standalone setup performs an installation in its own script root. That stateful mode must not be used on a completed evidence artifact.

## Manual commands

These commands operate only on the disabled synthetic instance above. `status` is read-only, including on an uninitialized or v1 instance. It does not migrate or establish a first-start cutoff.

```powershell
& node $cli --artifact $receipt --config $config status
if ($LASTEXITCODE -ne 0) { throw 'status failed' }
& node $cli --artifact $receipt --config $config start --port 0
if ($LASTEXITCODE -ne 0) { throw 'start failed' }
& node $cli --artifact $receipt --config $config status
if ($LASTEXITCODE -ne 0) { throw 'status failed' }
& node $cli --artifact $receipt --config $config stop
if ($LASTEXITCODE -ne 0) { throw 'stop failed' }
```

`start` returns a ready receipt with the actual `port`, `run_id`, config, DB, artifact and process identity. Before stopping, the page can be read at `http://127.0.0.1:<port>/`. `--port 0` selects an owned loopback port for isolated verification. Omitting that flag uses `[web] port`, whose default page is `http://127.0.0.1:8789/`. The override accepts `0..65535`; the configured port must be positive.

The daemon is manually launched through the Windows native bridge. It owns a canonical database named-pipe lock. Receipts bind PID, creation FILETIME, image and run id. `stop` requests graceful shutdown, then has a bounded exact-identity fallback for the owned daemon and registered watcher and CLI children. It does not stop OpenChamber chats or unrelated apps. A crash stays down until another explicit start. No service, scheduled task or automatic restart is installed.

## Runtime defaults

These values come from the exported schema in [config.ts](src/core/config.ts), not from a live instance or the excluded root configuration:

```json
{
  "tickets": { "enabled": false },
  "chats": { "enabled": false },
  "web": { "port": 8789 },
  "triage": { "providers": [], "model": "", "tool_limit": 8, "timeout_seconds": 120, "min_confidence": 0.75, "history_messages": 40 },
  "windows": { "outlook": 300, "teams": 120, "teamsrelay": 120, "gchat": 120, "gmail": 300, "oemail": 180, "slack": 120 },
  "jobs": {
    "triage_concurrency": 3,
    "turn_concurrency": 4,
    "lease_seconds": 120,
    "renew_seconds": 30,
    "backoff_initial_seconds": 10,
    "backoff_max_seconds": 1800,
    "backoff_jitter": 0.2,
    "max_attempts": 5,
    "max_recoveries": 2,
    "dependency_failure_threshold": 3,
    "collect_seconds": 10,
    "sync_seconds": 300,
    "heartbeat_seconds": 10,
    "archive_hours": 24,
    "reopen_days": 2,
    "purge_days": 30,
    "log_max_bytes": 10485760,
    "log_files": 5
  },
  "start": { "lookback_minutes": 0 }
}
```

Quiet windows are 300 seconds for Outlook and Gmail, 180 seconds for OE mail, 120 seconds for Teams, relay, Google Chat and Slack. An own-only batch gets `answered` and starts no turn. Own messages remain timeline and next-turn context. A mixed batch still follows routing and triage rules.

There are 3 triage slots and 4 reserved/in-flight chat-turn slots. Jobs hold fenced 120-second leases renewed every 30 seconds. Expired leases return to the queue. Collection, scheduling and daemon heartbeat use 10-second intervals. The page independently refreshes every 10 seconds. Direct-chat report sync runs every 300 seconds.

Approved sessions can be archived after 24 hours idle once local and remote pending work is excluded. New input in the chat of an active ticket goes to triage before the chat, once the chat's current input chain is through: triage gets that ticket's record (request, summary, last chat report and its newest 60 timeline entries) next to the chat history and that ticket as its only candidate, and decides whether the input is worth a chat turn. Input the chat should act on or know is forwarded; automatic replies (out of office, delivery or read notices), thanks, acknowledgements and other chatter are skipped as `not_on_us`, stay on the ticket's timeline and appear under Skipped, where Make ticket forwards them; a different request becomes a new proposal while the chat keeps routing to its ticket. A skip below `min_confidence` and a decision still invalid after repair are forwarded. Input a relink or merge moves to an active ticket is forwarded without that check. New input in the chat of a ticket closed within 2 days goes to triage, which gets the closed ticket's record (request, summary, how and when it was closed, last chat report and its newest 60 timeline entries) next to the chat history: only input that needs more work from Antonio on that request reopens it and unarchives its session; thanks, acknowledgements, call notices and other chatter are skipped and leave it closed; a different request becomes a new ticket that takes the chat, with the old one as context. Later work creates a proposal with the old ticket as context. Triage sees at most 30 candidate tickets, ranked by shared reference, shared people, open same-client and latest activity; a batch with a known client sees only that client's tickets. Purge clears only message text older than 30 days in unowned `not_on_us` batches without a routed conversation. It does not delete tickets or backup files. Logs rotate at 10485760 bytes with 5 retained files.

## Page and approval

The page shows Needs you, Working, Waiting on them, Failed, Done today and Skipped, plus source/dependency health, Problems and muted chats. Start approves the proposal. Open chat with note records Antonio's exact instruction and approves it. Dismiss records the optional reason as triage feedback. Done closes a ticket handled by hand with an optional note; it is not triage feedback, and within 2 days triage decides whether new linked messages reopen it. During the trial each chat brief asks the chat to report a failing or missing tool in the turn and in `99_Inbox/everflow-tool-issues.md` under the configured vault. These local actions enqueue work; they do not perform provider or source writes in the HTTP request.

Mute keeps a chat out of triage for 30 minutes, 1, 2 or 4 hours, until 9:00 the next morning (local time), 1 week, a custom number of minutes, hours or days up to one year, or until unmuted; the dialog shows when the mute ends. The page sends minutes (`minutes`, `mute_minutes`); `hours` and `mute_hours` from a page served by an older build are still accepted. It is offered on a Skipped batch and in the Dismiss dialog, where it mutes the dismissed ticket's routed conversations. New batches of a muted chat are stored as `muted` under Skipped, with no triage or forwarding; own-only batches stay `answered`. Make ticket on a muted batch ends that chat's mute. Muted chats are listed on the page with Unmute, and a timed mute ends by itself.

Chat creation requires both rollout switches enabled and explicit ticket approval. Chats off disables the chat actions during review. A created session has Antonio's normal OpenChamber tools and rules, with no Everflow deny override. Outward-facing text requires his approval in that chat before sending. The page does not approve outward text. No Teams self-chat or other channel approves or alerts on tickets.

The brief identifies source messages and knowledge-base contents as untrusted data. It requires canonical files, normal shared-write approval and no desktop activation. These instructions and the page controls are not a sandbox for tools in an approved normal chat.

Each completed turn ends with `STATUS: <working|needs_you|waiting_them|done> | <one line>`; `blocked` from older sessions still parses as Needs you. Reports use the assistant message identity and completion timestamp. A later direct-chat report is not overwritten by an older collector or polling time. The session title is `[<stage>] #<id> <title>` and follows the ticket's stage whatever changed it: each sync (every `sync_seconds`) compares it with the stage computed from the database and renames the session when they differ, so page actions (Done, Dismiss), a reopen, a turn running in the session and a reply without a valid STATUS are reflected within one sync. Open tickets are compared with the session itself, closed and dismissed ones with the title last written; a dismissed ticket gets a sync job only until its title says `[Dismissed]`; a ticket with a collector or input job running is left to that job. A reply without a valid STATUS still fails that ticket's sync and leaves the report unchanged. The page shows the stored session title for finding the chat. No working session deep-link is assumed.

## Backlog and migration

The first explicit v2 start persists `triage_after`, defaulting to that start's UTC time. A quoted aware `[start] triage_after` can set the initial cutoff. The persisted value wins on later starts. Unbatched messages with `stored_at` strictly before the cutoff become `backlog`, regardless of their source `sent_at`. They appear under Skipped rather than generating old proposals. Make ticket converts a skipped batch into a ticket or reuses its current routed ticket. A fresh proposal is not approved for chat by that action. Dismiss reasons and Make ticket counts remain visible as feedback.

`start` runs migration for its explicit instance before collection. For nonempty pre-v2 databases, [db.ts](src/core/db.ts) creates a uniquely named `.pre-v2-...db` SQLite backup and validates integrity and schema before upgrading. Source rows, cursors, numeric message identities and triage history are retained. Old work-item, draft, consent and send tables are removed from the migrated instance. Tickets begin empty. Old OpenChamber sessions are not resumed as v2 tickets.

Opening a v2 database adds the nullable `conversation.muted_until` column when it is missing. Existing rows keep their values, the schema version stays 2 and no backup is made for this step.

Source lookback defaults to zero and is capped at seven days for initial collection. Outlook and Teams resume with a rolling seven-day lower bound. Relay retains its saved initial replay floor across restarts. This policy does not change the stored-at backlog cutoff.

Held database migration, reading a held backup for acceptance, making a live copy and starting a live instance each require separate approval. No example here targets the held database or relay token. Existing backups and v1 proof files remain retained.

## Failure handling

The implementation is in [jobs.ts](src/core/jobs.ts), [kb-agent.ts](src/core/kb-agent.ts) and [chat.ts](src/core/chat.ts).

| Class | Examples | Policy |
|---|---|---|
| Dependency | HTTP 408, 429 or 5xx; a provider rate limit (`provider.rate-limit`, Retry-After read from the upstream body too); refused/reset/timed-out connections; COM `0x800706BA` or `0x80010001`; SQLite busy/locked | Backoff starts at 10 seconds, doubles to 1800 seconds, with 20% jitter. Retry-After is a minimum and can exceed that cap. Dependency failures do not consume attempts and never park a job. |
| Job | HTTP 400/403; 401 after fresh sign-in; missing session; programming error; triage decision still invalid after repair | Park immediately; a follow-up of an active ticket is forwarded instead. |
| Unknown | Unclassified failures | Same backoff. Consume an attempt. Park on the fifth attempt. |

Triage reads the new batch plus the latest 40 earlier batched messages of the same conversation, oldest first, each with `sent_at` and text capped at 2000 characters, and the current UTC time. `[triage] history_messages` sets that count, from 0 to 100. Triage gets one repair turn for an invalid decision. Both attempts share the maximum 8 tool calls and 120-second wall budget. Only read-only `vault_search` and `vault_read` are offered. Search is case-insensitive; a note matches when its path or text contains every word of the query. Folders are walked in name order, so numbered top-level folders rank first. One search reads at most 4096 notes, 256 KiB of each and 64 MiB in total; a read returns at most 32 KiB. Triage calls the provider directly, not through OpenChamber, so Antonio's normal instructions are not loaded; optional `[vault] guide` text describes the vault layout in the triage system prompt, and optional `[clients.<name>] role` text (up to 2000 characters) says what Antonio's work at that client is. Triage proposes only work Antonio himself has to do: a request put to him by name, with others or in a one-to-one chat, a question only he can answer, a decision or deliverable of his, an ask to his own team. A request meant for another person, a step only another team carries out, or mail where he is only in Cc is skipped unless it names him; a client role, where configured, decides what is his at that client. Providers are tried in configured order after dependency failures, without autostart. A route whose provider entry carries an `x-meridian-profile` header is checked every 60 seconds through Meridian's `GET <baseURL>/usage/quota/all` (local, no tokens): a profile with an error or failure is `failing` with Meridian's message and skipped until the next check, a profile with a window at 100% is `failing` with the window and its reset time and skipped until then, and any other profile is `ok` with its 5-hour and 7-day usage on the page, and an older triage-call backoff is cleared. Routes without the header keep health from their last triage call. A missing or invalid configured route is a job error.

Jobs for one ticket preserve FIFO order. A parked job blocks later work. A parked triage batch retains its messages and absorbs later messages of its conversation. Later forwards merge behind the parked forward. Manual retry resets the job's attempts, failures, error and retry time; it does not erase immutable turn history or its recovery budget, except that a retried collector parked on a spent budget sends one more recovery turn. Maintenance jobs `sync`, `archive` and `purge` retry indefinitely and report health instead of parking. They cannot be manually parked.

A failed chat turn gets at most 2 nondependency recovery turns for its original input. Dependency recovery uses backoff without consuming or resetting that budget. Recovery notes require checking sent items, pull requests and files before repeating outside actions. Budget exhaustion parks the collector and shows the ticket as Failed. Retry on that collector sends one more recovery turn, which is cancelled unsent when the ticket was closed meanwhile; Done or Dismiss cancels a collector parked after its turn ended, so it no longer holds the ticket's later input. A turn cut short by a later input in the same chat (a steer typed while it ran) never goes idle; once the session has worked on that later input, the collector closes the turn as interrupted and its batches as forwarded, with no recovery turn, because the chat already holds the input and sync collects the later report.

Session lookup uses durable store/ticket metadata, including archived sessions in the same directory. Duplicate tag matches are rejected. Prompt id, exact text and target are committed before HTTP submission. Restart reconciles existing ids against reachable history and inbox before retrying a proven-absent prepared prompt. Admitted inputs are collected. Unreachable history retains the reservation and blocks later input. [crash-matrix.test.ts](tests/crash-matrix.test.ts) injects real SQLite faults, lost acknowledgements and lease handoffs at triage, start, forward, recovery, collect, sync, archive and purge boundaries, then reopens the store and checks the shared invariants. A session create still in flight when its lease expires is not modeled; the 30-second client timeout is shorter than the 120-second lease.

Dependency health becomes failing after 3 consecutive errors and retains the first error's time. One success clears it. Source errors are visible immediately. A failed source scan does not acknowledge complete coverage. Invalid input enters quarantine without advancing a cursor for that line; that source remains blocked behind its unreplayed quarantine rows.

## Local remedies

Use actual internal ids from ticket details, `job list` and Problems. Set `$ticket`, `$sourceTicket`, `$targetTicket`, `$conversation`, `$job` and `$quarantine` accordingly. These are alternative remedies, not a batch to run blindly. The examples retain the selected receipt and absolute instance config:

```powershell
& node $cli --artifact $receipt --config $config ticket show $ticket
& node $cli --artifact $receipt --config $config job list
& node $cli --artifact $receipt --config $config job park $job --reason 'Investigating locally'
& node $cli --artifact $receipt --config $config job retry $job
& node $cli --artifact $receipt --config $config ticket relink $conversation $targetTicket
& node $cli --artifact $receipt --config $config ticket merge $sourceTicket $targetTicket
& node $cli --artifact $receipt --config $config ticket close $targetTicket --reason 'Resolved locally'
& node $cli --artifact $receipt --config $config quarantine replay $quarantine
& node $cli --artifact $receipt --config $config quarantine replay --all
```

Inspect the exact job error, fix its config, source reader or parser cause, then retry the same job. CLI retry accepts parked work or failed queued work. Page Retry accepts parked work. Make ticket also accepts a `muted` batch. Relink and merge refuse reserved, prepared, admitted or unresolved input rather than changing its target. Corrections write timeline entries. Closing preserves unresolved input for reconciliation.

Quarantine replay reuses the saved line after the underlying cause is fixed. It does not repair invalid bytes. Earlier unreplayed rows must be resolved first. Truncated input cannot be replayed. `--all` commits replay, messages, cursors and receipts together or rolls back the whole selection. Do not edit away failures or skip the barrier to advance a source.

## Source health

While the selected synthetic daemon is running, set `$port` to its returned ready/status port. The CLI status command reports daemon identity and metadata. Full source/account/provider health is exposed by the local page and `GET /api/state`:

```powershell
$state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state"
$state.health | ConvertTo-Json -Depth 5
```

Inspect `dependency`, `state`, `since`, `last_ok`, `last_error` and account checkpoints. Restore the named source prerequisite or provider route, then let the existing retry run. If a watcher process exited, an explicit Everflow stop/start is required; no app restart or TLS bypass is a remedy. Structured logs are beside the selected DB as `.log` and rotated suffixes. Raw unstructured watcher stderr is not retained because it can contain credentials.

## Sources

Source flags are independent of tickets/chats and default to disabled. Only enabled sources are launched.

An optional `accounts` list under `[sources.<name>]` limits an enabled source to those receiving accounts, compared case-insensitively. Messages of other accounts are dropped before storage and never reach triage. Account inventory and checkpoints still cover every account, so coverage stays complete and an account added later starts from that moment, without a backlog of the off period. Without the list every account of the source is on. The page shows an account outside the list as `off`. A changed list takes effect on the next start. Default compiled entrypoints are `dist/watchers/outlook.js`, `dist/watchers/teams.js`, `dist/watchers/relay.js`, `dist/watchers/gchat.js` and `dist/watchers/gmail.js` inside the selected artifact. No external watcher checkout is used. Google watchers invoke their installed CLI dependencies, not external watcher code.

OE Copilot endpoint: the relay, OE mail and Slack, and Gmail or Chat with `oe = true`, read through one HTTPS endpoint of OE Copilot, the communication service's `/everflow/*` routes (OE-Copilot `mcp/README.md`, "Everflow"). `[oe] url` is its address (`https://teams.everbright.it/communication`); `[oe] token_file` is a path relative to `config.toml` of a file holding its read-only token `EVERFLOW_TOKEN`, readable by the instance user only (laptop `%LOCALAPPDATA%\everflow\oe.token`, oe-vm `~/everflow/instance/oe.token`). The daemon reads the file at start and gives URL and token to those watchers in their environment (`EVERFLOW_OE_URL`, `EVERFLOW_OE_TOKEN`), never in their arguments. A missing `[oe]` is `source.oe-required`, a missing or empty token file or one with spaces or control characters `source.oe-token`, a URL that is not https (or http on localhost) or carries credentials, a query or a fragment `source.oe-url`: the daemon does not start. Transport failures carry the source's prefix: `http-failed` (network error, redirect or non-2xx from the endpoint, status kept), `timeout`, `aborted`, `result-limit` (an answer over 64 MiB, or the endpoint's 507 for one over its own cap), `response-json`, `oe-config` (URL or token unusable in the watcher). No SSH, shell or file access on the OE host is involved, so the same build runs wherever the URL is reachable. An old `host`, `data_dir`, `owner` or `store` key under the relay, OE mail or Slack is ignored; a `host` left under Gmail or Chat is `source.host-removed`, since dropping it would move that source to the local CLI (use `oe = true`).

- Outlook: [outlook.ts](src/watchers/outlook.ts) attaches to an already running Classic Outlook instance. Modern Outlook is unsupported. Every configured Outlook account's DeliveryStore Inbox and Sent folders are covered, for item classes 43, 53 and 54. A missing account, unreadable folder or failed covered item prevents a complete checkpoint. Scans use UTC DASL date filters, minute resolution and 2 minutes of overlap. OLE wall-clock conversion handles local timezone and DST; ambiguous fall-back times use the first occurrence. Polling defaults to 60 seconds. Native NewMailEx is unavailable with the pinned winax bridge because connection-point disposal is not supported. Polling is authoritative.
- Teams: [teams.ts](src/watchers/teams.ts) requires an explicit `[sources.teams] profile` identifying an existing signed-in local WebView profile. The reader uses its Cookies snapshot and adjacent Local State under the same Windows user, plus an instance-owned DPAPI cache. The runtime supplies private cache/snapshot paths; an optional bootstrap cache must be an explicitly selected compatible DPAPI cache. Expiring or rejected tokens refresh from the existing profile, never by restarting Teams. Missing profiles, unsupported cookies, expired accounts and certificate failures remain failures. Requests use the system CA store and never disable TLS validation. Cached, discovered and persisted expected accounts all contribute to coverage; the checkpoint requires every known account. Polling defaults to 30 seconds with 2 minutes of overlap. Source read receipts are never written.
- Relay: [relay.ts](src/watchers/relay.ts) reads through `[oe]`: one `GET /everflow/teams` per poll answers the saved-store snapshot of every active Teams relay account of the endpoint's administrator (the Teams relay `ADMIN_EMAIL`), read by the Teams relay itself with the read-only query the SSH transport ran before. A store the relay cannot read is that slot's `relay.store-unavailable`; an endpoint error fails the scan with `relay.http-failed` and its status. The fixed initial floor, including a 2-minute overlap, is replayed on each 30-second default poll and after restart. List-scan time and `observed_at` are health evidence, not message-body completeness, so they do not advance that floor. Main saved message text is capped at 2000 characters; quoted context can be prefixed separately. Only retained saved history is available. Receiving-account/native-id deduplication preserves legacy relay identity.

- Google Chat: [gchat.ts](src/watchers/gchat.ts) uses the installed `gweb` web-session CLI, without an OAuth project. `[sources.gchat] account` and `self_id` must explicitly identify the account and Google user id; every conversation read verifies the authenticated id. `gweb chat read SPACE_ID -n 1 --json --no-refresh` reports `self_id`. Rejected Google authentication attempts real HTTP cookie renewal and retries the read. By default the watcher passes `--no-refresh`, which forbids browser fallback. Only literal `[sources.gchat] browser_refresh = true` permits `--background-refresh`: gweb may open its saved Chrome profile minimized, capture existing sign-in cookies and retry. The saved session must contain a profile directory, recorded through explicit `gweb login --profile-dir "Profile 29" --wait 0`. No focus change, interactive sign-in or new consent is performed. A revoked session or required sign-in remains a visible failure; continuous authentication is not guaranteed. Older binaries fail on unsupported flags before session access. Polling defaults to 30 seconds; `topics` defaults to 200, allowed range 1..1000. Every space/DM returned by `chat ls` is reread, preserving native conversation/message/thread identities, own replies, edits, returned tombstones and attachment/link metadata. No files are downloaded. Topic limits, the upstream conversation-list limit and caps of 100 unread/20 read replies per topic mean this is recent-history coverage only. `coverage: "recent-topics"` and `observed_at` appear in source health. A successful scan does not advance a completeness cursor; unavailable older topics/replies remain outside coverage.
- OE mail: [oemail.ts](src/watchers/oemail.ts) reads the OE Copilot agent mailboxes through its `/api/communication` gateway behind `[oe]` (`POST /everflow/agent`, the agent's status and body per request); the agent API key and Microsoft tokens never leave the OE host. `accounts` is required and lists the mailboxes read. Each poll sends GET reads only, for Inbox and Sent Items, from the floor minus two minutes, following next links up to 20 rounds. Messages are keyed by `InternetMessageId`; text is `UniqueBody` without quoted history, HTML converted to text, capped at 50000 characters. Drafts are skipped. Mail from others carries `ref.addressed`: `to` or `cc` when the mailbox is on that recipient line, `other` when it got the mail through a distribution list or Bcc. A mailbox the agent reports as not `ok` fails the scan with `oemail.account-unavailable` and holds the checkpoint.
- Gmail: [gmail.ts](src/watchers/gmail.ts) uses the installed Google Workspace CLI `gws` and its existing authentication. `[sources.gmail] account` is required and must match `gmail users getProfile`. Access needs `gmail.readonly` or an existing broader mail scope; the watcher performs GET operations only. Polling defaults to 30 seconds, configurable through `poll_seconds`. It searches Inbox and Sent with epoch-second bounds, two minutes of overlap and all returned pages, up to 100 pages of 500 results. Full message bodies are MIME-decoded, preferring plain text over HTML alternatives, capped at 50000 characters. Attachment names and sizes are stored without fetching binaries. Large text bodies provided only as external attachment data fail explicitly with `gmail.body-unavailable`. Native thread ids group conversations; message ids deduplicate replays. Sent labels or a matching From address identify own replies. Unread labels, flags and source read state remain unchanged. A failed profile, page, message or MIME decode prevents the complete checkpoint. Gmail draft, spam and trash folders are not collected.

- Gmail and Google Chat through the OE agent: `oe = true` under `[sources.gmail]` or `[sources.gchat]` replaces the local CLI with the OE Copilot agent behind `[oe]`, over the same `/everflow/agent` route as OE mail ([oe-google.ts](src/watchers/oe-google.ts)): `/api/communication/gmail/read` and `/api/communication/gchat/read`, so the Gmail grant and the Chat cookies stay on the OE host and no `gws` or `gweb` runs on this machine. `executable` and `browser_refresh` are ignored there. Records, `account` and `self_id` checks, checkpoints and coverage are the same as the CLI transports. Gmail sends its message reads 50 per endpoint call; Chat lists the conversations once per poll and rereads, 8 per endpoint call, only those whose last activity is not older than the replay floor, so an edit or deletion in a conversation with no newer message is not seen. Through the agent, Chat keeps only what concerns Antonio: the agent's group detail (read once per conversation) tells app DMs, which are never read, from DMs with people and unnamed group chats, which are kept whole, and named spaces, of which only the threads with a mention of Antonio or a message of his are kept, unless the space's name or id is listed in `[sources.gchat] full_spaces`. A mention is `@` followed by his display name in the text (`self_name`, or the name on his own messages); a mention sets `mentions_me`. Transport errors keep the OE mail codes (`oemail.http-failed`, `oemail.http` with the agent's status) under the `gmail` or `gchat` source. An agent Chat answer `409` means its Google session needs a new import: `autologin` target `oe-gchat`, on the OE host's renew timer, logs in to Google over HTTP and imports a fresh session. With `oe = true`, `[sources.gmail] accounts` may list several agent mailboxes instead of one `account`; each is read as above and one checkpoint covers them all once every one is read. A Gmail grant the agent can no longer refresh is renewed by the `autologin` targets `oe-gmail-tecnomat` and `oe-gmail-itv` (PKCE consent in a headless browser).
- Slack: [slack.ts](src/watchers/slack.ts) reads one workspace with the browser session slackcli keeps on the OE host for the communication MCP (`workspaces.json`), through `[oe]`. `[sources.slack] account` (the receiving address used for routing), `self_id` (the Slack user id) and `workspace` (team id) are required. The communication service calls the Slack Web API with that session (`POST /everflow/slack`), so the token and cookie never leave the OE host; only read methods are allowed, nothing is marked read. Each poll calls `auth.test` (user and team must match), `client.counts` (per conversation of the user, its latest message and an `updated` time that thread replies also move) and `subscriptions.thread.getView` (followed threads), then `conversations.history` for conversations with either newer than the floor minus two minutes, reaching 3 days further back so that parents with a newer `latest_reply` are found, and `conversations.replies` for those threads, 25 calls per endpoint call. Names come from `conversations.info` and `users.info`, cached for the watcher's life; a sender with a profile email is stored by that email. Joins, leaves and other system messages are skipped. DMs and group DMs are kept whole; a channel keeps only the threads that tag the user (`<@self_id>`), that he wrote in, or that Slack has him following; the rest of the channel never reaches Everflow. A reply under a parent more than 3 days older than the floor, in a thread the user does not follow, is not seen. Mentions of the user set `mentions_me`. A Slack `ok: false` fails the scan with `slack.api` and the method and Slack error as reason; `invalid_auth` means the session needs `autologin` target `oe-slack` on the OE host.

Both CLI Google watchers use [cli-json.ts](src/watchers/cli-json.ts): no shell, 60-second subprocess deadline (240 seconds for opted-in Chat browser refresh), 16 MiB output ceiling, cancellation and exact-identity child tracking. Raw CLI stderr is discarded; fixed error codes and exit status reach source health. Optional `executable` selects an installed CLI by name or path, never an arbitrary command string. A changed authenticated account fails closed. CLI installation, interactive login, browser focus and consent are never performed by the daemon.

Example source settings for a separately approved instance:

```toml
[oe]
url = "https://teams.example/communication"
token_file = "oe.token"

[sources.gchat]
enabled = false
account = "me@example.invalid"
self_id = "GOOGLE_USER_ID"
poll_seconds = 30
topics = 200
browser_refresh = false
# full_spaces = ["Team space"]   # with oe = true: named spaces read whole, not only threads that concern you

[sources.gmail]
enabled = false
account = "me@example.invalid"
poll_seconds = 60
# oe = true   # read through the OE Copilot agent behind [oe] instead of gws (same key under [sources.gchat] for gweb)
# accounts = ["me@example.invalid", "other@example.invalid"]   # with oe = true: several agent mailboxes

[sources.slack]
enabled = false
account = "me@example.invalid"
self_id = "U00000000"
workspace = "T00000000"
poll_seconds = 60
```

The original three sources remain independent. Tesco is absent from the recorded relay inventory. Synthetic fixtures do not establish real-source acceptance; read-only scratch checks and their observed limits are recorded separately.

## Linux host (oe-vm)

The same build runs on Linux. [kernel.ts](src/posix/kernel.ts) gives the daemon, runtime and watchers process identities from `/proc/<pid>/stat` (start time in clock ticks) and `/proc/<pid>/exe`; a child that exited before its identity was read is a zombie and reads as exited. The instance lock is an abstract Unix socket named after the database, released by the kernel with its last owner. Outlook, Teams desktop and DPAPI stay Windows-only and fail with `native.windows-x64-required`.

Two settings serve a host that is not the desktop:

- `[web] public_origin = "https://<host>"`: a reverse proxy in front of the loopback port serves the page under that HTTPS address. Host `<host>` and Origin `https://<host>` are then accepted next to the loopback ones; the action token is unchanged. Requests under that host need a signed-in session; see Sign-in below. Loopback requests stay as before.
- `[web] chat_origin = "https://<chat host>"`: the OpenChamber web UI of `[opencode] openchamber_port`, served by the same reverse proxy behind the page's sign-in; see OpenChamber web below. Needs `public_origin` and `openchamber_port`. Without it the board offers only the app link, as before.
- `[opencode] openchamber_port`: with an empty `url`, the chats go to an `openchamber serve` web server on that loopback port, signed in with `OPENCHAMBER_UI_PASSWORD` from the environment, instead of the desktop settings file.

The oe-vm instance is declared in `deploy/vm` and deployed by `.github/workflows/ci-cd.yml`:

| File | Role |
|---|---|
| `config.toml` | Instance config, installed into `~aptul4ever/everflow/instance` on every deploy; triage routes come from the VM `opencode.jsonc`, the laptop's file mirrored by the instructions repo `setup/oracle-vm/push-opencode.ps1`. Its `[oe]` token file `oe.token` (mode 600) is placed by hand once and stays in the instance folder across deploys. Without it the new build does not start and `receive.sh` rolls back to the previous build and its `config.toml` (`config.toml.prev`) |
| `everflow.service`, `run.sh` | systemd user unit of `aptul4ever`; the daemon runs `_run` in the foreground on the build pinned in `build.txt`, restarts on failure |
| `Caddyfile`, `compose.yml` | `everflow-caddy`: TLS (TLS-ALPN through sslh) for `https://flow.everbright.it`, proxy to `127.0.0.1:8789`; `https://chat.flow.everbright.it`, the OpenChamber web UI on `127.0.0.1:3000` behind the page sign-in; the former `https://everflow.217-76-49-98.sslip.io` answers 301 to the same path there |
| `receive.sh` | Forced command of the pipeline key: verifies the archive, builds, installs the files above and the sign-in account (`login.env`), pins, restarts, rolls back when the page does not answer |
| `bootstrap.sh` | One-time root setup: Docker group, Node `26.4.0` in `~/.local/lib/node26`, sslh SNI line for both names (missing names only, one backup and one restart per run), deploy key |

Pull requests run the build and the test gate on Linux ([gate.ts](scripts/gate.ts)). A push to `main` deploys only when the commit belongs to a merged pull request; a direct push fails the `guard` job and stays undeployed. The `main` ruleset in `deploy/github/main-ruleset.json` (pull request required, `Build and test` green and up to date, no force push, no deletion, no bypass) needs a paid GitHub plan on this private repository, where the API answers 403 on the free plan; apply it with `gh api repos/Aptul9/everflow/rulesets --input deploy/github/main-ruleset.json`. Merged branches are deleted automatically. Secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `EVERFLOW_USER`, `EVERFLOW_PASSWORD` (page sign-in; only its scrypt hash reaches the VM, as `EVERFLOW_LOGIN_HASH` in `~/everflow/instance/login.env`). Variable: `DEPLOY_DOMAIN`.

On the VM, as `aptul4ever`: `systemctl --user status everflow`, `journalctl --user -u everflow`, logs beside the database in `~/everflow/instance`. Rollback: put the previous receipt path into `~/everflow/instance/build.txt` and `systemctl --user restart everflow`, or revert the commit on `main` through a pull request.

## Sign-in

With `[web] public_origin` set, the daemon refuses to start unless `EVERFLOW_LOGIN_USER` and `EVERFLOW_LOGIN_HASH` are in its environment; the hash comes from `EVERFLOW_PASSWORD=... node scripts/hash-password.ts` (scrypt, N 32768). Under the public host every request except `GET /login`, `/_next/static/*` and the icons needs the `everflow_session` cookie: a page request goes to `/login?next=<path>`, an API request gets 401 with `x-everflow-login: required`, and the board then opens the sign-in screen by itself. `POST /api/login` (JSON `email`, `password`, same Origin) answers 204 with the cookie: HttpOnly, Secure, SameSite=Lax, 30 days, HMAC-SHA256 over its expiry and the account, key in `<db>.login-key` (0600), so sessions survive restarts and a changed account or password ends them all. The email is compared case-insensitively and the hash is checked on every attempt. Five failed attempts from one client in 15 minutes lock that client for 15 minutes (429 with `Retry-After`), thirty from all clients lock the form; the client is the last `X-Forwarded-For` entry, which Caddy sets. `POST /api/logout` clears the cookie; the board shows Sign out under the public host only. Loopback requests (the VM itself, the deploy health check) need no session.

With `[web] chat_origin` set to a host under the public one, the cookie carries `Domain=<public host>`, so it reaches the page and the chat host and no other name; otherwise it stays host-only. `next` after signing in is a path on the page, or an absolute address on `chat_origin` and nowhere else. A session cookie from before `chat_origin` was set is host-only: `GET /login` under the public host renews it with the domain. `POST /api/logout` clears both forms.

## OpenChamber web

The Everflow sign-in also opens the OpenChamber web UI at `[web] chat_origin`: whoever signs in to the page gets OpenChamber in full, chats, files and terminal included, and the terminal is a shell as the user OpenChamber runs as (`aptul4ever` on oe-vm). No second password is asked.

Caddy sends every request to the chat host first to the daemon's gate, `GET /api/chat-gate` on loopback (`forward_auth`, Host forced to `127.0.0.1:8789`), after dropping any `Authorization` the client sent. With a valid `everflow_session` cookie the gate answers 204 and `X-Everflow-Chat-Authorization: Bearer oc_client_...`, which Caddy puts on the upstream request as `Authorization`; OpenChamber accepts that remote-client token like its own session cookie, for HTTP, events and websockets. Without a session the gate answers 401 and Caddy redirects to `<public origin>/login?next=<chat address>`. The gate answers 404 under the public host and to any request that is not Caddy's for the chat host, so the token never reaches a browser.

The daemon mints the token itself with the UI password it already has (`POST /auth/session` with `issueClientToken`, label `Everflow web`, dedupe key `everflow-web`, so a new one replaces the previous), keeps it in `<db>.chat-token` (0600) and reuses it across restarts. It checks it with OpenChamber at most once a minute and mints again on 401 or a day before it expires (OpenChamber gives 7 days); a refused mint waits a minute before the next try. Revoke it in OpenChamber (Settings, remote clients, `Everflow web`): the next request mints a new one. OpenChamber routes that need its own session (passkeys, sign-out everywhere, the remote client list) refuse the bearer token. Session links open as `<chat_origin>/?session=<id>`; the board header shows an OpenChamber button that opens `chat_origin` in a new tab.

On the board a chat's Open shows it in a dialog on the page: OpenChamber's own chat view, `<chat_origin>/mini-chat.html?mode=session&sessionId=<id>&directory=<folder>` (messages, context gauge, composer with model and agent), framed from the chat host with the same sign-in. The dialog header links the same chat in OpenChamber (new tab) and in the app (`openchamber://`). After Discuss the dialog opens once the daemon has created the chat. That view finds a session only among the sessions of OpenChamber's projects and otherwise shows an empty chat, so the page first asks `POST /api/ticket/<id>/open-chat`: the daemon reads the session's folder from OpenChamber (`GET /api/session/<id>`) and registers it as a project (`POST /api/projects/session-directory`, what OpenChamber's full UI does when it opens a session from a folder it does not list; a folder already listed is left as it is). A session OpenChamber no longer has answers 404 and the dialog says so; a folder OpenChamber wants trusted first answers 409. The chat host replaces OpenChamber's `Content-Security-Policy` (`frame-ancestors` of its desktop and mobile shells only) with `frame-ancestors 'self' https://<public host>`. Keys typed in the chat stay in the chat (a cross-origin frame), so Esc there is OpenChamber's; Esc on the dialog header, the close button and a click outside close the dialog.

The chat host serves `/mini-chat.html` and `/everflow-bridge.js` from the daemon, not from OpenChamber: after the gate, Caddy sends both to `/api/chat-bridge/...` on loopback (Host forced to `127.0.0.1:8789`, the gate's `Authorization` dropped). The daemon fetches the chat view from OpenChamber with the client token, adds `<script src="/everflow-bridge.js?parent=<public origin>" defer>` before `</head>` once and returns it with OpenChamber's headers; when OpenChamber does not answer it returns a page saying so. Both answer 404 under the public host and to any request that is not Caddy's for the chat host, like the gate. The script posts to the page's origin only. A click on a file the chat names (a path link in its text, the file name on a tool row) opens that file in the panel beside the chat as a tab; a file already open is focused, not opened twice. The view's pop-out button, which needs OpenChamber's desktop shell, is hidden and a Close button in its place closes the dialog. The page accepts messages only from the chat host's origin and from that frame; when the view has not reported its bridge 6 seconds after it loaded, the dialog shows its own Close.

The panel starts closed: Files opens it on the newest file the chat wrote, a file clicked in the chat opens it on that file. It lists the files the chat wrote or edited and any file clicked in the chat. A clicked file opens when the chat's history names it anywhere, a file it only read or a path in its text or a command included, relative paths taken from the session folder; it must exist and be a regular file inside the home folder of the user the daemon runs as, links followed, at most 10 MB. The panel header toggles the file list, expands the panel over the chat and closes it; per file it copies the path, switches between preview and source (Markdown and text), finds with every match marked and next/previous, shows the outline of Markdown headings, downloads and reloads.

## Local request security

The server binds only `127.0.0.1`. Before Next.js routing, Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`, or the host of `[web] public_origin`; the chat host never reaches the daemon except through the loopback gate. Each server start creates a fresh action token. POST requires `x-everflow-token` and an Origin matching that exact Host (`https://` for the public one). Reload the page after restart or a rejected token. No CORS access is granted. Source/model text is rendered as escaped React text, never raw HTML. Assets and fonts are local.

The Host/Origin/token controls protect local page actions. They do not constrain normal approved-chat tools or grant outward-send/shared-write approval.

## Git metadata

Tests run from the completed stage. Git provenance comes from the explicit source checkout `$source`, never staged `.git`. Generate a fresh read-only index inventory before each suite. This PowerShell block preserves an empty JSON array, paths containing spaces and a failing Git exit:

```powershell
try {
  $index = (& git -C $source ls-files -z -- '*.py' 'requirements.txt' 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "git exit $LASTEXITCODE" }
} catch { throw "Git index inventory failed: $_" }
$tracked = [string[]]@($index -split "`0" | Where-Object { $_.Length -gt 0 })
$env:TEST_TRACKED_LEGACY_PATHS = ConvertTo-Json -InputObject $tracked -Compress
```

An absent variable, malformed JSON or Git failure must stop testing. A staged filesystem scan cannot establish tracked legacy deletion. No Git tree, default config or user state is copied into the build to satisfy these checks.

## Test gates

Keep both artifact variables and the fresh Git metadata. The inline TypeScript launcher uses the existing builder environment helper for private profiles/caches and the build-root variable. Test children explicitly use `NODE_ENV=test` for the React test API. Production server fixtures select their own production environment. The launcher runs both typechecks and Vitest with the completed stage as cwd. It installs nothing and starts no live source:

```powershell
$env:TEST_BUILD_RECEIPT = $receipt
$env:EVERFLOW_ARTIFACT = $receipt
$run = @'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from './scripts/build.ts';
import { readBuildReceipt } from './src/web/build-artifact.ts';
const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
assert.equal(process.env.EVERFLOW_ARTIFACT, process.env.TEST_BUILD_RECEIPT);
assert(process.env.TEST_TRACKED_LEGACY_PATHS !== undefined);
assert(Array.isArray(JSON.parse(process.env.TEST_TRACKED_LEGACY_PATHS)));
const env = { ...isolatedEnvironment(artifact.root, process.env),
  NODE_ENV: 'test',
  TEST_BUILD_RECEIPT: process.env.TEST_BUILD_RECEIPT,
  EVERFLOW_ARTIFACT: process.env.EVERFLOW_ARTIFACT,
  TEST_TRACKED_LEGACY_PATHS: process.env.TEST_TRACKED_LEGACY_PATHS };
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.server.json'],
  ['node_modules/vitest/vitest.mjs', 'run'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: artifact.root, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
'@
Push-Location -LiteralPath $build.root
try {
  & node --input-type=module-typescript --eval $run
  if ($LASTEXITCODE -ne 0) { throw 'Staged gates failed' }
} finally { Pop-Location }
```

[readme.test.ts](tests/readme.test.ts) checks the supplied README hash, real compiled help/defaults, native verify-only, actual PowerShell CLI examples on owned scratch instances, loopback page/source health, local corrections/replay, backlog promotion and Git metadata edge cases. [build-isolation.test.ts](tests/build-isolation.test.ts) checks the named README supply without broadening the source boundary. Synthetic starts explicitly disable all sources and both rollout switches. They establish no live-source, browser or model acceptance.

## Live checks

[live-checks.ts](scripts/live-checks.ts) drives acceptance on owned scratch instances. Every command requires `--opt-in`, a `--scenario` name and a `--run-root` under `C:/Users/Antonio/AppData/Local/Temp/opencode/everflow/live-checks`. Run it with Node from the completed stage, never from the checkout.

Before any connection, spawn or file read, the guard refuses the held database, its sidecars and the relay token. It also refuses case, stream, trailing-dot and short-name spellings, traversal, paths outside the run root, link or junction components, hard-linked state and existing databases not recorded in the run manifest. The only accepted seed is `data/backups/pre-review-resume-20261104-234928.db`, copied into a fresh run. A final-component symlink among read-only inputs is resolved to its declared target, which then passes the same checks.

`init` writes an owned config whose triage routes start with a known-closed loopback route. `start`, `stop`, `status` and `kill` act on recorded identities only. `state`, `detail` and `inspect` read the page, API and scratch database. `approve` and `make-ticket` use the page token and Origin. `remote`, `interrupt` and `archive` act only on sessions tagged with the run's store and directory; `archive` skips running sessions and sessions with queued input.

## Later rollout gates

- Live checks touch only owned scratch instances. Held database access, migration or a live copy requires explicit approval before any operation.
- Live source startup and source/profile acceptance require their own approved scope. Google Chat/Gmail adapters do not activate an existing instance; absent relay accounts remain outside coverage.
- The review period uses tickets on and chats off. It ends only on Antonio's explicit decision. Chat activation and any harmless real-chat proof require separate approval.
- Default-branch merge remains a separate decision. Passing implementation tests do not authorize it.
- V1 proof cleanup requires explicit confirmation naming the artifacts. Backups remain retained. No proof, cache or backup deletion is part of this procedure.

Code rollback uses revert commits. A database rollback uses a new parallel instance restored from a retained backup and a separately selected config, preserving the original instance. No database deletion or destructive overwrite is required.

Earlier unassigned startup timeout, receipt-publication errno/holder failures and the original tracing incident remain recorded. Passing documentation examples or later tests do not diagnose or clear them. No claim is made that protected state has historically remained untouched or that staging is an OS sandbox. Live Outlook acceptance has not run: Classic Outlook was not running during the recorded live checks, so only its explicit not-running failure was observed.
