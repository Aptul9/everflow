# Possible future implementations

Candidates collected on 2026-11-08 from a comparison with Paperclip (https://github.com/paperclipai/paperclip, docs at https://docs.paperclip.ing). None is approved or scheduled. Each one needs its own design and an owner decision before code.

## Paperclip comparison outcome

Paperclip is an orchestration server for autonomous agent teams: issues, agents with adapters, routines, approvals, budgets. It was not adopted as a replacement or as a backend.

- No personal-inbox ingestion. The Microsoft Teams connector requires an Entra application, a single-tenant Azure Bot, tenant administrator approval and a public HTTPS endpoint, and receives only chats where the bot is installed. Gmail and Google Chat connectors are agent tools, not inbox triggers.
- Its approvals cover agent hires, strategy and budget overrides. Assigning a task wakes the agent; there is no per-task approval gate equivalent to Start.
- The `opencode_local` adapter runs headless `opencode run` with `dangerouslySkipPermissions: true` by default, which replaces the user's permission rules with `permission=allow`. Workdesk chats run in OpenChamber under the normal rules.
- A hybrid (Workdesk triage creating Paperclip issues through a routine webhook) would add a second server, a second UI and a second job layer, and would move the chats out of OpenChamber.

Already covered by Workdesk: atomic checkout (fenced leases), wake coalescing (quiet windows), activity log (ticket timeline), external triggers (planned OE communication API source).

## Candidates from Paperclip

### Cost per ticket and budget stop

Paperclip reference: Costs & Budgets (https://docs.paperclip.ing/guides/day-to-day/costs/).

- Record tokens and cost per triage call and per chat turn, summed per ticket and per day, shown on the ticket card and in the page header.
- Source: the token and cost fields OpenCode returns on assistant messages, and the triage provider response usage. No provider quota endpoint, which keeps the README rule against provider-specific logic.
- Optional daily cap: when reached, triage and new chat turns wait and the page shows the stop; collection continues.
- Motivation: the Meridian `notarify` five-hour window was exhausted on 2026-11-04 (vault, inbox-dispatcher Traps), and the target is about 100 tickets per day.

### Snooze, decide-by and proposal expiry

Paperclip reference: Decisions (https://docs.paperclip.ing/guides/day-to-day/decisions/).

- Snooze a proposal until a date or time; it leaves Needs you and returns when due.
- Decide-by target per ticket (today, this week, date), sorting Needs you by deadline.
- Unanswered proposals expire after a configurable period (Paperclip default: 7 days). Expiry is recorded separately from Dismiss, so triage feedback distinguishes "rejected" from "ignored".

### Done-claim check

Paperclip reference: Task Watchdogs (https://docs.paperclip.ing/guides/projects-workflow/task-watchdogs/).

- Today `STATUS: done` closes the ticket on the chat's own claim.
- Option A: `done` moves the ticket to a Review lane; the owner confirms closure on the page.
- Option B: a small-model pass reads the last turns and checks for evidence (sent item, PR, file, command output) before closing; missing evidence keeps the ticket open with a note.
- Paperclip fingerprints the reviewed state so the same stop is checked once; the same applies here.

### Typed proposal options

Paperclip reference: Decisions, proposed decisions with up to eight options and a drift check.

- Triage proposes 2 to 4 concrete next actions per ticket instead of one free-text proposal.
- Start with a chosen option puts that action into the chat brief.
- Drift check: if new messages arrived on the conversation after the proposal, the page says so before Start.

## Dropping native Windows code after the OE Copilot move

Decision `2026-11-08-workdesk-oe-communication-api` (vault): after the trial, mail and Google sources are read from the OE agent `/api/communication/*` over SSH, and Teams stays on the relay store read. Native code in use on 2026-11-08:

| Module | Native API | Used by | After the move |
|---|---|---|---|
| `src/windows/com.ts` | `winax`, `GetActiveObject` | `watchers/outlook.ts` | Removed with the Outlook source |
| `src/windows/dpapi.ts`, `snapshot.ts` | `koffi`, `CryptUnprotectData` | `watchers/teams-auth.ts` (Teams desktop source) | Removed once the accounts on the Teams desktop source (bip on 2026-11-08) are read through relay or OE |
| `src/windows/kernel.ts` | `koffi`, `CreateProcessW`, `OpenProcess`, handle inventory | `server.ts`, `dispatcher/daemon.ts`, `dispatcher/runtime.ts`, `watchers/source.ts` | Stays: detached daemon start, exact process identity, watcher child tracking and stop |

- Once only `kernel.ts` is left, it can be replaced with Node `child_process.spawn({ detached: true })` plus a PID and start-time record, or the watchers can run inside the daemon as HTTP/SSH pollers with no child processes.
- With `koffi` and `winax` gone: no MSVC build tools, no node-gyp Python, no native verification step in `scripts/build.ts` and `scripts/setup.ts`, and a smaller case for the source-only build staging.
- The service could then run on Linux, for example on oe-vm next to the OE agent, with SSH replaced by local calls. The page stays loopback-only, so remote use needs a private route (SSH tunnel or Tailscale).

## Operational items found during the review

### Builds outside Temp

- `BUILD_PARENT` is hardcoded to `C:/Users/Antonio/AppData/Local/Temp/opencode/inbox-dispatcher-v2/source-builds` (`src/web/build-artifact.ts:5`), and `readBuildReceipt` accepts only artifacts there.
- On 2026-11-08 the folder held 586 builds; one build with `node_modules` is about 751 MB. Storage Sense temp cleanup is enabled on this PC, and the pinned build lives in that folder.
- Candidate: a stable build root under the instance folder or `%LOCALAPPDATA%\workdesk\builds`, with pruning that keeps the pinned build and the last N.

### Relay replay floor

- The relay floor never advances (`src/watchers/relay.ts:147`): every poll rereads all saved rows since the first start.
- Above 10000 rows in a slot the source fails with `relay.result-limit` (`src/watchers/relay.ts:104`, `:127`).
- Candidate: advance the floor to the newest message confirmed stable for a margin longer than the detached body-save delay, keeping the overlap.
