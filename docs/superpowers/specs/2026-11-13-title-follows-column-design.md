---
created: 2026-11-13
status: approved design, not implemented
repo: Aptul9/everflow, base branch chore/rename-everflow (3d25b03)
target path in repo: docs/superpowers/specs/2026-11-13-title-follows-column-design.md
---

# Everflow: session title follows the board column, event-driven

## Goal

The OpenCode session title of a ticket changes the moment the ticket's card changes board column, within about 2 s, without a polling cycle. Title and column use the same word.

## Current state (3d25b03, live build-978o3e)

- Title `[stage] #id title` is derived in code (`stageTitle`, `src/core/tickets.ts`); the chat only writes the STATUS line that sets `ticket.report`.
- `scheduleMaintenance` (`src/core/runtime.ts`) compares derived vs stored title every 10 s tick and makes the per-ticket sync due; the sync renames (`alignTitle`, `src/core/chat.ts`). Typical lag about 20 s.
- Chat running/finished is seen only by the per-ticket sync (`markRunning`, `latestReport`), interval `sync_seconds = 60` in instance config.
- Stage names: Failed, Needs you, Working, Waiting on them, Idle, Done, Dismissed. Board columns (`src/lib/web-types.ts`): Needs you, Working, Waiting on them, Failed, Done, Skipped. Idle sits in Working, Dismissed in Skipped.
- `@opencode/client` 2.2.5 exposes `client.event.subscribe()` (SSE) with `session.status`, `session.idle`, `session.execution.started|succeeded|failed`, `session.renamed`.
- Page actions (Next route handlers) and the runtime run in one process (`src/server.ts`), but in separate module graphs, so an in-memory emitter is not reliably shared.

## Decisions

- Approach A (owner choice): SQLite triggers mark tickets whose column may have moved; a retitle worker drains them; the OpenCode event stream feeds chat running/finished. Rejected: call-site hooks (B, every future write path must remember the hook), 1 s timer compare (C, still a timer).
- Title vocabulary = board column names (owner choice): Idle shows `[Working]`, Dismissed shows `[Skipped]`.

## Components

### 1. Column function

- `boardColumn(stage: Stage): Column` in `src/core/tickets.ts`: Idle -> Working, Dismissed -> Skipped, others unchanged (Done -> Done).
- `stageTitle(db, ticket)` returns `[${boardColumn(stage)}] #${id} ${title}`.
- `projectedTitle` in `src/core/chat.ts` uses `boardColumn` too.
- `readState` grouping (`src/web/state.ts`) is expressed through `boardColumn`, so board and title cannot disagree.

### 2. Dirty marks

- Table `stage_dirty(ticket INTEGER PRIMARY KEY REFERENCES ticket, at TEXT NOT NULL)`.
- Triggers (`CREATE TRIGGER IF NOT EXISTS`, created in `openDb` next to `lookupIndexes`), each `INSERT OR REPLACE INTO stage_dirty(ticket,at)`:
  - `ticket` AFTER UPDATE OF `lifecycle, report, chat_running_at, title, session_id, merged_into`
  - `job` AFTER INSERT, AFTER UPDATE OF `state`, when `NEW.ticket IS NOT NULL`
  - `turn` AFTER INSERT, AFTER UPDATE OF `state`
- Writes outside these columns (summary, timeline, refs) do not mark.
- First start after deploy: mark every ticket with `session_id` once, so all titles move to column names in one pass.

### 3. Retitle worker

- Async loop owned by `startRuntime`; wake function registered at `globalThis[Symbol.for('everflow.retitle.wake')]`.
- Woken by: runtime after its own commits; `actionPost` (`src/web/api.ts`) after a page action commit; the event handler; stream (re)connect.
- Per dirty ticket:
  - no `session_id` or not approved: clear the mark.
  - collect/start_chat/forward job `running` for the ticket: leave the mark (the collector writes the title with its report; its job-state change re-marks afterwards).
  - derived title equal to `session_title`: clear the mark, no OpenCode call.
  - otherwise `peer.rename`, read back with `peer.get`, store `session_title`, clear the mark.
- OpenCode failure: keep the mark, retry with backoff counting consecutive failures only (1 s doubling, cap 30 s); no timeline `failure` rows; health `opencode:events` carries the state.
- Marks for one ticket collapse to one row; one pass per wake handles a burst.

### 4. OpenCode event stream

- One persistent `client.event.subscribe()` in the daemon, built through `connect(cfg)` on every (re)connect, so the rotated OpenChamber password is re-read.
- Only events whose `sessionID` equals some `ticket.session_id` are handled; others ignored.
- `session.status` busy or `session.execution.started`: set `ticket.chat_running_at` (trigger marks dirty, worker renames to `[Working]`).
- `session.idle`, `session.execution.succeeded`, `session.execution.failed`: clear `chat_running_at`, make that ticket's sync job due now (report read and column move).
- `session.renamed` to a title different from the derived one: mark dirty. The echo of the worker's own rename equals the derived title and is a no-op.
- Reconnect backoff 1 s doubling, cap 30 s. Health row `opencode:events`: `retrying`/`failing` with last error while down, `ok` on connect.
- On every successful connect: drain all marks and reconcile all ticket sessions once (covers events missed while disconnected).

### 5. Polling as safety net

- Remove the per-tick title compare added in PR 31 (`scheduleMaintenance` `retitle`); keep the counter reset on rearm.
- Per-ticket sync stays for reports; code default `sync_seconds` 300 already; remove `sync_seconds = 60` from instance `config.toml` (backup `config.toml.pre-title-events`).
- When a sync's `alignTitle` finds a stale title, log `title.repaired` with the ticket id, so trigger or event gaps are visible.

## Error handling

| Case | Behavior |
|---|---|
| OpenCode down or restarting | Stream drops, renames fail, marks persist; reconnect 1-30 s; on connect drain + reconcile |
| Event for unknown session | Ignored |
| Own rename echoed as `session.renamed` | Equal to derived title, no-op |
| Worker vs collector | Worker skips while input running; collector's job-state change re-marks |
| Burst of writes | One mark row per ticket, one rename |
| Missed event or uncovered write | 5 min sync repairs and logs `title.repaired` |

## Testing

- `boardColumn` mapping; `readState` groups and `stageTitle` agree for every stage.
- Triggers: each listed write leaves exactly one mark; unlisted writes leave none.
- Worker: rename once and clear; keep on failure and retry; skip while input running then handle; no call when equal.
- Event handler on a scripted stream: busy -> `[Working]`; idle -> sync due now; foreign rename -> put back; own echo -> no call; unknown session -> ignored; drop + reconnect -> drain + reconcile, health retrying -> ok.
- Full gate with README receipt env (`TEST_BUILD_RECEIPT`, `EVERFLOW_ARTIFACT`, `TEST_TRACKED_LEGACY_PATHS`, `isolatedEnvironment`).
- Live: send in OpenChamber -> `[Working]` <= 2 s; turn end with STATUS -> column title <= 2 s plus report read; page Done -> `[Done]` <= 2 s; manual rename -> restored <= 2 s; OpenChamber restart -> `opencode:events` retrying then ok, all titles match.

## Rollout

- Branch `feat/title-follows-column`, PR into `chore/rename-everflow`.
- Rollback: `build.txt.pre-title-events` into instance `build.txt`, `config.toml.pre-title-events` into `config.toml`, stop/start. Triggers and `stage_dirty` are additive; an older build ignores them.

## Out of scope

- OpenChamber sidebar ordering.
- How the chat writes STATUS.
- Push updates for the Everflow page (still 10 s poll).
