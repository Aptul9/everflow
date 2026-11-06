# inbox-dispatcher

TypeScript inbox collection, local ticket proposals and approved OpenChamber chats. SQLite holds the queue and processed markers. Source read state is never changed. The dispatcher has no mail or chat send transport and no channel-based approvals or alerts.

Tickets and chats are disabled by default. Source collection has its own switches. Implementation and synthetic tests do not authorize live migration, source activation or chat activation.

## Prerequisites

- Windows x64 and Node.js `26.4.0`, including its npm distribution. The lockfile pins TypeScript `7.0.2`, Next.js `16.4.5`, `koffi` `3.3.7` and `winax` `3.6.10`.
- MSVC C++ build tools with a Windows SDK. The recorded toolchain uses Visual Studio 2026 Build Tools. Native compilation also requires a node-gyp-compatible Python interpreter. It is build tooling only. The application, watchers, CLI and tests use TypeScript/Node.
- Network access to the lockfile's dependency downloads during the private build. Source-specific access is separate and unnecessary for the disabled synthetic instance below.
- For live triage, an explicit read-only knowledge-base root, model and ordered provider ids in `[triage]`. Provider routes come from `triage.provider_config_path` or the existing OpenCode JSONC settings. No provider is installed, started or selected automatically.
- For approved chats, an already running OpenChamber server and its existing settings. An empty `opencode.url` reads `~/.config/openchamber/settings.json` for `desktopLocalPort` and `desktopUiPassword`. An explicit HTTP(S) `opencode.url` uses that server instead, with optional `INBOX_OPENCODE_PASSWORD`. `opencode.directory` identifies the session directory. A nonempty model uses `provider/model` form.

The dispatcher never starts, focuses, closes or restarts a desktop app. Provider quota endpoints, provider lifecycle helpers and daemon autostart are absent. Source prerequisites are described below.

## Build

Run from the source checkout with the pinned Node version:

```powershell
npm run build
```

This is the clean setup and production-build command. No checkout dependency installation or standalone setup is required first. The dependency-free controller in [scripts/build.ts](scripts/build.ts) creates a fresh source-only stage. It runs private `npm ci --include=dev --foreground-scripts --no-audit --no-fund`, native verification, Next.js production compilation and server compilation there.

The build supplies only named root inputs, including this README, and approved TypeScript/TSX/CSS source and the historical SQL test fixture. It excludes the default instance configuration, environment files, Git metadata, documentation trees, databases and user state. Source links, junctions and hard links are rejected. Dependency links and output traces must remain inside the stage. Project, Turbopack and tracing roots are pinned to that stage.

Dependencies, npm configuration, profile, cache, node-gyp headers and temporary files are private to the stage. Build output currently lives under `C:/Users/Antonio/AppData/Local/Temp/opencode/inbox-dispatcher-v2/source-builds`, as declared in [build-artifact.ts](src/web/build-artifact.ts). The final JSON line contains `buildReceipt`, an absolute path to a completed `build-receipt.json`. A prepared stage is not a runnable artifact.

No checkout `dist` or `.next` is required. Do not invoke Next.js directly in the checkout. Staging is not an OS sandbox or a complete filesystem/network audit.

## Select an artifact

Keep one completed receipt selected explicitly. Never select the newest directory or fall back to checkout output. These PowerShell bindings create a new synthetic instance directory only:

```powershell
$source = Read-Host 'Absolute source checkout path, not the staged root'
$receipt = Read-Host 'Absolute completed buildReceipt path from npm run build'
$build = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
if ($build.status -ne 'complete') { throw 'Completed build receipt required' }
$cli = Join-Path $build.root 'dist/cli.js'
$scratch = Join-Path $env:LOCALAPPDATA ('Temp/opencode/inbox-dispatcher-v2/manual-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch -ErrorAction Stop | Out-Null
$config = Join-Path $scratch 'config.toml'
```

Both receipt and config paths passed to the CLI must be absolute. Every non-help command validates a completed artifact before opening the explicit instance config. `INBOX_DISPATCHER_ARTIFACT` is an alternative explicit receipt input; examples retain `--artifact` on each command. The checkout package launcher forwards to the selected compiled CLI. No default config or artifact fallback exists.

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
```

Only a literal TOML `true` enables tickets or chats. Missing switches, strings such as `"true"` and other values stay disabled. Configuration is loaded at startup. A changed file requires a manual restart to take effect. The old shadow, dispatch, approval, delivery and watcher-command settings are ignored by [config.ts](src/dispatcher/config.ts).

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

`--verify-only` and `--log` are setup-script flags, not build or dispatcher flags. Without `--verify-only`, standalone setup performs an installation in its own script root. That stateful mode must not be used on a completed evidence artifact.

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

The daemon is manually launched through the Windows native bridge. It owns a canonical database named-pipe lock. Receipts bind PID, creation FILETIME, image and run id. `stop` requests graceful shutdown, then has a bounded exact-identity fallback for the owned daemon and registered watcher/SSH children. It does not stop OpenChamber chats or unrelated apps. A crash stays down until another explicit start. No service, scheduled task or automatic restart is installed.

## Runtime defaults

These values come from the exported schema in [config.ts](src/dispatcher/config.ts), not from a live instance or the excluded root configuration:

```json
{
  "tickets": { "enabled": false },
  "chats": { "enabled": false },
  "web": { "port": 8789 },
  "triage": { "providers": [], "model": "", "tool_limit": 8, "timeout_seconds": 120, "min_confidence": 0.75 },
  "windows": { "outlook": 300, "teams": 120, "teamsrelay": 120 },
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
    "reopen_days": 14,
    "purge_days": 30,
    "log_max_bytes": 10485760,
    "log_files": 5
  },
  "start": { "lookback_minutes": 0 }
}
```

Quiet windows are 300 seconds for Outlook and 120 seconds for Teams and relay. An own-only batch gets `answered` and starts no turn. Own messages remain timeline and next-turn context. A mixed batch still follows routing and triage rules.

There are 3 triage slots and 4 reserved/in-flight chat-turn slots. Jobs hold fenced 120-second leases renewed every 30 seconds. Expired leases return to the queue. Collection, scheduling and daemon heartbeat use 10-second intervals. The page independently refreshes every 10 seconds. Direct-chat report sync runs every 300 seconds.

Approved sessions can be archived after 24 hours idle once local and remote pending work is excluded. Linked work can reopen a done ticket within 14 days and unarchive its session. Later work creates a proposal with the old ticket as context. Purge clears only message text older than 30 days in unowned `not_on_us` batches without a routed conversation. It does not delete tickets or backup files. Logs rotate at 10485760 bytes with 5 retained files.

## Page and approval

The page shows Needs you, Working, Waiting on them, Failed, Done today and Skipped, plus source/dependency health and Problems. Start approves the proposal. Open chat with note records Antonio's exact instruction and approves it. Dismiss records the optional reason. These local actions enqueue work; they do not perform provider or source writes in the HTTP request.

Chat creation requires both rollout switches enabled and explicit ticket approval. Chats off disables the chat actions during review. A created session has Antonio's normal OpenChamber tools and rules, with no dispatcher deny override. Outward-facing text requires his approval in that chat before sending. The page does not approve outward text. No Teams self-chat or other channel approves or alerts on tickets.

The brief identifies source messages and knowledge-base contents as untrusted data. It requires canonical files, normal shared-write approval and no desktop activation. These instructions and the page controls are not a sandbox for tools in an approved normal chat.

Each completed turn ends with `STATUS: <working|needs_you|waiting_them|blocked|done> | <one line>`. Reports use the assistant message identity and completion timestamp. A later direct-chat report is not overwritten by an older collector or polling time. The page shows the stored session title for finding the chat. No working session deep-link is assumed.

## Backlog and migration

The first explicit v2 start persists `triage_after`, defaulting to that start's UTC time. A quoted aware `[start] triage_after` can set the initial cutoff. The persisted value wins on later starts. Unbatched messages with `stored_at` strictly before the cutoff become `backlog`, regardless of their source `sent_at`. They appear under Skipped rather than generating old proposals. Make ticket converts a skipped batch into a ticket or reuses its current routed ticket. A fresh proposal is not approved for chat by that action. Dismiss reasons and Make ticket counts remain visible as feedback.

`start` runs migration for its explicit instance before collection. For nonempty pre-v2 databases, [db.ts](src/dispatcher/db.ts) creates a uniquely named `.pre-v2-...db` SQLite backup and validates integrity and schema before upgrading. Source rows, cursors, numeric message identities and triage history are retained. Old work-item, draft, consent and send tables are removed from the migrated instance. Tickets begin empty. Old OpenChamber sessions are not resumed as v2 tickets.

Source lookback defaults to zero and is capped at seven days for initial collection. Outlook and Teams resume with a rolling seven-day lower bound. Relay retains its saved initial replay floor across restarts. This policy does not change the stored-at backlog cutoff.

Held database migration, reading a held backup for acceptance, making a live copy and starting a live instance each require separate approval. No example here targets the held database or relay token. Existing backups and v1 proof files remain retained.

## Failure handling

The implementation is in [jobs.ts](src/dispatcher/jobs.ts), [kb-agent.ts](src/dispatcher/kb-agent.ts) and [chat.ts](src/dispatcher/chat.ts).

| Class | Examples | Policy |
|---|---|---|
| Dependency | HTTP 408, 429 or 5xx; refused/reset/timed-out connections; COM `0x800706BA` or `0x80010001`; SQLite busy/locked | Backoff starts at 10 seconds, doubles to 1800 seconds, with 20% jitter. Retry-After is a minimum and can exceed that cap. Dependency failures do not consume attempts and never park a job. |
| Job | HTTP 400/403; 401 after fresh sign-in; missing session; programming error; triage decision still invalid after repair | Park immediately. |
| Unknown | Unclassified failures | Same backoff. Consume an attempt. Park on the fifth attempt. |

Triage gets one repair turn for an invalid decision. Both attempts share the maximum 8 tool calls and 120-second wall budget. Only read-only `vault_search` and `vault_read` are offered. Providers are tried in configured order after dependency failures, without quota checks or autostart. A missing or invalid configured route is a job error.

Jobs for one ticket preserve FIFO order. A parked job blocks later work. A parked triage batch retains its messages and absorbs later messages of its conversation. Later forwards merge behind the parked forward. Manual retry resets the job's attempts, failures, error and retry time; it does not erase immutable turn history or its recovery budget. Maintenance jobs `sync`, `archive` and `purge` retry indefinitely and report health instead of parking. They cannot be manually parked.

A failed chat turn gets at most 2 nondependency recovery turns for its original input. Dependency recovery uses backoff without consuming or resetting that budget. Recovery notes require checking sent items, pull requests and files before repeating outside actions. Budget exhaustion parks the collector and shows the ticket as Failed.

Session lookup uses durable store/ticket metadata, including archived sessions in the same directory. Duplicate tag matches are rejected. Prompt id, exact text and target are committed before HTTP submission. Restart reconciles existing ids against reachable history and inbox before retrying a proven-absent prepared prompt. Admitted inputs are collected. Unreachable history retains the reservation and blocks later input. This does not prove universal exactly-once session creation across every crash boundary; the later crash harness remains required.

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

Inspect the exact job error, fix its config, source reader or parser cause, then retry the same job. CLI retry accepts parked work or failed queued work. Page Retry accepts parked work. Relink and merge refuse reserved, prepared, admitted or unresolved input rather than changing its target. Corrections write timeline entries. Closing preserves unresolved input for reconciliation.

Quarantine replay reuses the saved line after the underlying cause is fixed. It does not repair invalid bytes. Earlier unreplayed rows must be resolved first. Truncated input cannot be replayed. `--all` commits replay, messages, cursors and receipts together or rolls back the whole selection. Do not edit away failures or skip the barrier to advance a source.

## Source health

While the selected synthetic daemon is running, set `$port` to its returned ready/status port. The CLI status command reports daemon identity and metadata. Full source/account/provider health is exposed by the local page and `GET /api/state`:

```powershell
$state = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state"
$state.health | ConvertTo-Json -Depth 5
```

Inspect `dependency`, `state`, `since`, `last_ok`, `last_error` and account checkpoints. Restore the named source prerequisite or provider route, then let the existing retry run. If a watcher process exited, an explicit dispatcher stop/start is required; no app restart or TLS bypass is a remedy. Structured logs are beside the selected DB as `.log` and rotated suffixes. Raw unstructured watcher stderr is not retained because it can contain credentials.

## Sources

Source flags are independent of tickets/chats and default to disabled. Only enabled sources are launched. Default compiled entrypoints are `dist/watchers/outlook.js`, `dist/watchers/teams.js` and `dist/watchers/relay.js` inside the selected artifact. No external watcher checkout or executable fallback is used.

- Outlook: [outlook.ts](src/watchers/outlook.ts) attaches to an already running Classic Outlook instance. Modern Outlook is unsupported. Every configured Outlook account's DeliveryStore Inbox and Sent folders are covered, for item classes 43, 53 and 54. A missing account, unreadable folder or failed covered item prevents a complete checkpoint. Scans use UTC DASL date filters, minute resolution and 2 minutes of overlap. OLE wall-clock conversion handles local timezone and DST; ambiguous fall-back times use the first occurrence. Polling defaults to 60 seconds. Native NewMailEx is unavailable with the pinned winax bridge because connection-point disposal is not supported. Polling is authoritative.
- Teams: [teams.ts](src/watchers/teams.ts) requires an explicit `[sources.teams] profile` identifying an existing signed-in local WebView profile. The reader uses its Cookies snapshot and adjacent Local State under the same Windows user, plus an instance-owned DPAPI cache. The runtime supplies private cache/snapshot paths; an optional bootstrap cache must be an explicitly selected compatible DPAPI cache. Expiring or rejected tokens refresh from the existing profile, never by restarting Teams. Missing profiles, unsupported cookies, expired accounts and certificate failures remain failures. Requests use the system CA store and never disable TLS validation. Cached, discovered and persisted expected accounts all contribute to coverage; the checkpoint requires every known account. Polling defaults to 30 seconds with 2 minutes of overlap. Source read receipts are never written.
- Relay: [relay.ts](src/watchers/relay.ts) requires `[sources.teamsrelay] host`, absolute remote `data_dir` and `owner`, existing noninteractive SSH access and an already installed remote `sqlite3`. Only that owner's active stores are queried through `sqlite3 -readonly -json`, query-only transactions and checked arguments. Nothing is installed or deployed. The fixed initial floor, including a 2-minute overlap, is replayed on each 30-second default poll and after restart. List-scan time and `observed_at` are health evidence, not message-body completeness, so they do not advance that floor. Main saved message text is capped at 2000 characters; quoted context can be prefixed separately. Only retained saved history is available. Receiving-account/native-id deduplication preserves legacy relay identity.

Google Chat is blocked on OAuth and has no shipped watcher. Tesco is absent from the recorded relay inventory. Neither is claimed as a working live integration. Source feasibility and unit fixtures do not replace later real-source acceptance.

## Local request security

The server binds only `127.0.0.1`. Before Next.js routing, Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. Each server start creates a fresh action token. POST requires `x-dispatcher-token` and an Origin matching that exact local Host. Reload the page after restart or a rejected token. No CORS access is granted. Source/model text is rendered as escaped React text, never raw HTML. Assets and fonts are local.

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
$env:INBOX_DISPATCHER_ARTIFACT = $receipt
$run = @'
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { isolatedEnvironment } from './scripts/build.ts';
import { readBuildReceipt } from './src/web/build-artifact.ts';
const artifact = readBuildReceipt(process.env.TEST_BUILD_RECEIPT);
assert.equal(process.env.INBOX_DISPATCHER_ARTIFACT, process.env.TEST_BUILD_RECEIPT);
assert(process.env.TEST_TRACKED_LEGACY_PATHS !== undefined);
assert(Array.isArray(JSON.parse(process.env.TEST_TRACKED_LEGACY_PATHS)));
const env = { ...isolatedEnvironment(artifact.root, process.env),
  NODE_ENV: 'test',
  TEST_BUILD_RECEIPT: process.env.TEST_BUILD_RECEIPT,
  INBOX_DISPATCHER_ARTIFACT: process.env.INBOX_DISPATCHER_ARTIFACT,
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

## Later rollout gates

- Phase 10 crash harness and guarded live acceptance remain separate work. Held database/backup access, migration or a live copy requires explicit approval before any operation.
- Live source startup and source/profile acceptance require their own approved scope. Google Chat and absent relay accounts remain blocked until actual evidence changes that status.
- The review period uses tickets on and chats off. It ends only on Antonio's explicit decision. Chat activation and any harmless real-chat proof require separate approval.
- Default-branch merge remains a separate decision. Passing implementation tests do not authorize it.
- V1 proof cleanup requires explicit confirmation naming the artifacts. Backups remain retained. No proof, cache or backup deletion is part of this procedure.

Code rollback uses revert commits. A database rollback uses a new parallel instance restored from a retained backup and a separately selected config, preserving the original instance. No database deletion or destructive overwrite is required.

Earlier unassigned startup timeout, receipt-publication errno/holder failures and the original tracing incident remain recorded. Passing documentation examples or later tests do not diagnose or clear them. No claim is made that protected state has historically remained untouched, that staging is an OS sandbox or that live/browser acceptance is complete.
