# Everflow sources through one OE Copilot endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everflow reads Teams relay, Outlook, Gmail, Google Chat and Slack through `https://teams.everbright.it/communication/everflow/*` with one read-only token, with no SSH anywhere.

**Architecture:** The communication service (`OE-Copilot/mcp`, container `communication-mcp`) gains three read-only routes that forward the request shapes Everflow already speaks to the agent, Slack and a new Teams relay route on the Docker network. Everflow swaps its SSH transports for HTTP implementations of the same seams (`OeCall`, `SlackCall`, relay reads); parsing and ingest stay unchanged. All SSH code and the oe-vm root key go.

**Tech Stack:** Rust (hyper 1, reqwest, tokio LocalSet) for the communication service; Next.js 16 route handlers, better-sqlite3, vitest for the Teams relay; Node 26 TypeScript, zod, vitest for Everflow.

**Spec:** `docs/superpowers/specs/2026-11-17-oe-endpoint-design.md`

## Global Constraints

- Repos: OE Copilot `C:\Users\Antonio\Downloads\personal projects\OE-Copilot` (remote `Aptul9/OE-Copilot`), Everflow `C:\Users\Antonio\Downloads\personal projects\everflow` (remote `Aptul9/everflow`). Pushes with the `Aptul9` gh token per command (GCM returns another account).
- One branch per repo: `feat/everflow-endpoint` in OE Copilot, `feat/oe-endpoint-sources` in Everflow (exists, holds the spec). PR body empty, Conventional Commits, no AI signature.
- Route prefix `/everflow/` on the communication service; public URL `https://teams.everbright.it/communication/everflow/...`.
- Token variable `EVERFLOW_TOKEN` on the communication service, at least 32 characters (`MIN_TOKEN`); unset = routes answer 404. `MCP_HTTP_TOKEN` never opens `/everflow/*`, `EVERFLOW_TOKEN` never opens `/mcp`.
- Agent paths allowed: `/api/communication/accounts` (GET, no body), `/api/communication/read`, `/api/communication/gmail/read`, `/api/communication/gchat/read` (POST with body). Nothing else.
- Slack methods allowed: exactly `READ_METHODS` of `everflow/src/watchers/slack.ts`: `auth.test`, `client.counts`, `subscriptions.thread.getView`, `conversations.history`, `conversations.replies`, `conversations.info`, `users.info`. Workspace id `^T[A-Z0-9]+$`.
- Teams relay route `GET /api/everflow/saved?since=<ms>&max_rows=<n>`, bearer `MCP_TOKEN` only, owner = `mcpUserId()` (`ADMIN_EMAIL`, today `aptul99@gmail.com` = Everflow `owner`). Answer `{"slots":[{"slot":N,"snapshot":"<text>"}|{"slot":N,"error":"<reason>"}]}`.
- Everflow config: `[oe] url = "https://teams.everbright.it/communication"`, `token_file = "<path relative to config.toml>"`. Daemon passes `EVERFLOW_OE_URL` and `EVERFLOW_OE_TOKEN` to watchers through the environment, never argv.
- Everflow records, `message_id` values, checkpoints and non-transport error codes stay byte-identical.
- Transport codes per prefix (`relay`, `oemail`, `slack`): `<p>.http-failed` (network error or non-2xx from the endpoint, status carried), `<p>.timeout`, `<p>.aborted`, `<p>.result-limit`, `<p>.response-json`, `<p>.oe-config` (URL or token missing). `<p>.ssh-start`, `<p>.ssh-failed`, `<p>.invalid-host`, `relay.absolute-path` leave `diagnosticCodes`.
- GitHub Actions deploys over SSH and Unison stay untouched.

## Review Focus

- Token rejected (401 from the endpoint): the source goes `failing` with `<p>.http-failed` status 401 and no checkpoint advances; never an empty successful scan. Test in Task 3.
- Endpoint reachable, backend down (agent 502, Teams relay unreachable): agent and Slack statuses pass through per request so `oemail.http` / `oemail.account-unavailable` / `slack.api` keep today's meaning; `/everflow/teams` answers 502 and Everflow reports `relay.http-failed`. Tests in Task 2 and Task 6.
- First stop after upgrade reads a daemon receipt still listing `kind: "ssh"` children: stop must succeed. Test in Task 7.
- Large answers (Gmail batch of 50, relay since 2026-11-10 is about 1600 messages): a body over the cap is `<p>.result-limit`, never a truncated parse. Test in Task 3.
- Tokens crossed between routes (`EVERFLOW_TOKEN` on `/mcp`, `MCP_HTTP_TOKEN` on `/everflow/*`): 401. Test in Task 2.

---

### Task 1: Teams relay route `GET /api/everflow/saved`

**Files:**
- Create: `OE-Copilot/teams-relay/app/src/lib/everflow-saved.ts`
- Create: `OE-Copilot/teams-relay/app/src/app/api/everflow/saved/route.ts`
- Test: `OE-Copilot/teams-relay/app/test/everflow-saved.test.ts`

**Interfaces:**
- Consumes: `tokenMatches`, `mcpUserId` (`src/lib/mcp/access.ts`), `appDb` (`src/lib/appdb.ts`), `slotDbPath` (`src/lib/slotdb.ts`), `route`, `HttpError` (`src/lib/http.ts`), `config.mcpToken`.
- Produces: `savedSince(userId: string, since: number, maxRows: number): { slots: ({ slot: number; snapshot: string } | { slot: number; error: string })[] }` and the route `GET /api/everflow/saved`.

- [ ] **Step 1: Write the failing tests** in `test/everflow-saved.test.ts`, set up like `test/mcp-route.test.ts` (temp `APP_DB`, `ADMIN_EMAIL=admin@teamsrelay.test`, `"user"` row `admin-id`, `claimSlot` for admin twice and for `someone-else` once, one admin slot set `stopped=1`, slot stores via `createSlotDb` with `state` rows `me`, `last_scan_ts`, a muted chat and `chat_messages` with mids `1790431000000`, `1790432000000`, a non-numeric mid `abc`):
  - `refuses without the token`: no header, `Bearer wrong`, a session cookie: 401. `Origin: https://x` with the right token: 403. `MCP_TOKEN` unset: 404.
  - `rejects bad parameters`: `since=-1`, `since=x`, `max_rows=0`, `max_rows=100001`, missing `since`: 400.
  - `returns the admin's active slots only, in slot order`: slots = admin non-stopped slots; the stopped slot and `someone-else`'s slot absent.
  - `snapshot matches the Everflow store query`: `JSON.parse(snapshot)` has `state.me`, `state.last_scan_ts`, `muted` = `["<muted chat>"]`, `messages` only mids `>= since`, numeric only, ascending; a 2001-character text comes back 2000 characters.
  - `max_rows + 1 rows`: with `max_rows=1` and two qualifying messages, `messages.length === 2`.
  - `missing store is that slot's error`: delete one admin slot's `messages.db`; that entry is `{ slot, error: "store-unavailable" }`, the other slot still has `snapshot`, status 200.
- [ ] **Step 2: Run** `npx vitest run test/everflow-saved.test.ts` in `teams-relay/app`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `savedSince`** in `src/lib/everflow-saved.ts`: slots `SELECT slot FROM teams_accounts WHERE owner_id=? AND stopped=0 ORDER BY slot LIMIT 1025`; each store opened `new Database(slotDbPath(slot), { readonly: true, fileMustExist: true })`, `PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;`, then the exact SQL of `storeQuery` in `everflow/src/watchers/relay.ts` with `since` and `maxRows + 1` bound as parameters, `.pluck().get()` for the `snapshot` text; any throw gives `{ slot, error: "store-unavailable" }`; store always closed.
- [ ] **Step 4: Implement the route** `src/app/api/everflow/saved/route.ts`: `export const dynamic = "force-dynamic"`; `GET = route(...)`: 404 when `config.mcpToken` empty, 403 with `Origin`, 401 unless `tokenMatches(authorization)`, 400 on parameters (`since` safe integer >= 0, `max_rows` integer 1..100000), 503 when `mcpUserId()` is null, else `Response.json(savedSince(...))`.
- [ ] **Step 5: Run** the test file, then `scripts/check.sh teams-relay` (or the suite the repo's `teams-relay.yml` runs). Expected: PASS.
- [ ] **Step 6: Commit** `feat(teams-relay): saved messages since a time for everflow`.

### Task 2: Communication service routes `/everflow/{agent,slack,teams}`

**Files:**
- Create: `OE-Copilot/mcp/src/everflow.rs`
- Modify: `OE-Copilot/mcp/src/lib.rs` (module), `mcp/src/http.rs` (`App.everflow: Option<String>`, dispatch before the `/mcp` check), `mcp/src/main.rs` (`EVERFLOW_TOKEN`), `mcp/src/gateway.rs`, `mcp/src/slack.rs`, `mcp/src/teams.rs`, `.github/workflows/mcp.yml` (`EVERFLOW_TOKEN: ${{ secrets.EVERFLOW_TOKEN }}` in the `.env` list), `mcp/README.md` (routes, variable)
- Test: `OE-Copilot/mcp/tests/server.rs` (new cases), unit tests in `everflow.rs`

**Interfaces:**
- Consumes: `Gateway`, `Slack`, `Teams` already in `Communication`; `bearer_matches`, `hosts`, `json`, `empty` in `http.rs`; Task 1's route.
- Produces:
  - `Gateway::raw(&self, path: &str, body: Option<&Value>) -> Result<(u16, String)>`: same allow-list and key as `call`, 30 s timeout, any status, body as text.
  - `Slack::raw(&self, workspace: &str, method: &str, params: &[(String, String)]) -> Result<(u16, String)>`: workspace resolved by `workspace_id` through the existing `workspace()` lookup, same auth headers as `attempt`, 30 s timeout, shares `LIMITER`, no retry.
  - `Teams::saved(&self, since: u64, max_rows: u32) -> Result<(u16, String)>`: GET `<origin of OUTLOOK_MCP_TEAMS_URL>/api/everflow/saved?since=..&max_rows=..` with the relay `MCP_TOKEN`, 60 s timeout.
  - `pub async fn handle(app: &App, req: Request<Incoming>, path: &str) -> Response<Body>` in `everflow.rs`.
  - Wire format, request and answer:
    - `POST /everflow/agent` `{"requests":[{"path":"...","body":{...}}]}` -> `{"responses":[{"status":200,"body":"<text>"}]}`
    - `POST /everflow/slack` `{"workspace":"T...","requests":[{"method":"...","params":{"k":"v"}}]}` -> `{"responses":[{"status":200,"body":"<text>"}]}`
    - `GET /everflow/teams?since=..&max_rows=..` -> the relay body verbatim on 200; 502 `{"error":"teams relay HTTP <n>"}` otherwise or when unreachable; 404 when Teams is off.
  - Limits: at most 100 requests per agent or slack call (400 above), requests run in order, total answer above 64 MiB stops with 502 `{"error":"answer too large"}`.

- [ ] **Step 1: Write the failing tests** in `tests/server.rs`, reusing the fake backend: add fake answers for `/api/communication/accounts`, `/api/communication/read` (one 200, one 502), Slack `conversations.history`, and `/api/everflow/saved` (200 JSON when the bearer is the relay token, else 401). Cases:
  - `everflow_routes_need_their_own_token`: `/everflow/agent` with no bearer, `MCP_HTTP_TOKEN`, wrong token: 401; with `Origin`: 403; wrong `Host`: 421; `EVERFLOW_TOKEN` on `/mcp`: 401; `App.everflow = None`: 404.
  - `agent_passes_status_and_body_through`: two requests, answers in order, the 502 one carries status 502 and the fake body.
  - `agent_refuses_paths_outside_the_list`: `/api/communication/gmail/write` or `/api/x` in any request: 400 and the fake backend saw no call.
  - `slack_reads_only_the_read_methods`: `chat.postMessage`: 400, no call; `conversations.history` with a browser workspace in the fake store: 200 passthrough, the fake saw `token=` form field and `Cookie: d=`.
  - `teams_forwards_saved`: 200 body equal to the fake's; fake relay down: 502.
  - `more_than_100_requests_is_refused`: 101 requests: 400.
- [ ] **Step 2: Run** `cargo test --locked` in `mcp` (Linux Rust image or WSL, per `mcp/README.md`). Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `Gateway::raw`, `Slack::raw`, `Teams::saved`, `everflow::handle`, the `http.rs` dispatch (`path.starts_with("/everflow/")` after `/healthz`, same Host and Origin rules, constant-time bearer against `app.everflow`) and `main.rs` (`EVERFLOW_TOKEN` optional; when set and shorter than `MIN_TOKEN`, `fail(...)`; startup line says `Everflow on|off`).
- [ ] **Step 4: Run** `cargo test --locked` and `scripts/check.sh mcp`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(mcp): read-only everflow routes for agent, slack and teams`.

### Task 3: Everflow HTTP transport `oe-endpoint.ts`

**Files:**
- Create: `everflow/src/watchers/oe-endpoint.ts`
- Test: `everflow/tests/oe-endpoint.test.ts`

**Interfaces:**
- Produces:
  - `export interface OeEndpoint { url: string; token: string }`
  - `export function oeEndpoint(source: Source, prefix: string, env?: NodeJS.ProcessEnv): OeEndpoint`: reads `EVERFLOW_OE_URL` (https, or http on localhost) and `EVERFLOW_OE_TOKEN`; throws `SourceError(source, '<prefix>.oe-config')` when either is missing or the URL is not acceptable.
  - `export async function oeRequest(source: Source, prefix: string, endpoint: OeEndpoint, route: string, init: { method: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> }, signal?: AbortSignal, limits?: { timeoutMs?: number; maxBytes?: number }, fetchImpl?: typeof fetch): Promise<unknown>`: `<url>/everflow/<route>`, `Authorization: Bearer`, `redirect: 'error'`, default timeout 90 000 ms and 64 MiB; streams the body and stops at `maxBytes`; returns parsed JSON.

- [ ] **Step 1: Write the failing tests** against a local `node:http` server on 127.0.0.1:
  - `sends the bearer and json body to the everflow route`.
  - `missing url or token is <prefix>.oe-config`, and `ftp://` or `http://example.com` URLs too.
  - `401 is http-failed with status 401` (Review Focus 1), `502 is http-failed with status 502`, connection refused is `http-failed` without status.
  - `body over maxBytes is result-limit` (server streams `maxBytes + 1` bytes; Review Focus 4).
  - `slow server is timeout`, `aborted signal is aborted`, `non-JSON body is response-json`.
- [ ] **Step 2: Run** `npx vitest run tests/oe-endpoint.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `oeEndpoint` and `oeRequest` in `src/watchers/oe-endpoint.ts`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sources): https transport to the oe copilot endpoint`.

### Task 4: oemail, gmail, gchat through `/everflow/agent`

**Files:**
- Modify: `everflow/src/watchers/oemail.ts` (remove `oeCommand`, `parseOeOutput`, `sshOeCall`, `B64`, the `sshRun` import; add `httpOeCall`; `oeMailMain` without `--host`), `src/watchers/gmail.ts:142-151`, `src/watchers/gchat.ts:131-140` (`--oe` boolean replaces `--host`), `src/watchers/oe-google.ts` (comment only)
- Test: `everflow/tests/oemail-source.test.ts`, `tests/oe-google-source.test.ts`, `tests/gmail-source.test.ts`, `tests/gchat-source.test.ts` (whichever hold the SSH-shape tests: replace them)

**Interfaces:**
- Consumes: Task 3 `oeEndpoint`, `oeRequest`.
- Produces: `export function httpOeCall(endpoint: OeEndpoint, source?: Source): OeCall`: POST `agent` with `{ requests }`, returns `responses` validated as `{ status: number; body: string }[]` of the same length (else `oemail.response-shape`), transport errors under prefix `oemail`, `source` as today.

- [ ] **Step 1: Write the failing tests**: `httpOeCall` against a local server returns responses in order; length mismatch is `oemail.response-shape`; `scanOeMail` with an `OeCall` fake still emits the same records as before (existing tests keep their fakes, only the SSH-shape tests are replaced); `gmailMain` and `gchatMain` with `--oe` and `EVERFLOW_OE_*` in env read through `httpOeCall`; `--oe` without env is `oemail.oe-config`.
- [ ] **Step 2: Run** the four test files. Expected: new tests FAIL.
- [ ] **Step 3: Implement** `httpOeCall`; `oeMailMain`, `gmailMain`, `gchatMain` build it from `oeEndpoint(source, 'oemail')`.
- [ ] **Step 4: Run** the four test files. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(sources): oe mail and google reads over https`.

### Task 5: Slack through `/everflow/slack`

**Files:**
- Modify: `everflow/src/watchers/slack.ts` (remove `slackCommand`, `sshSlackCall`, `STORE`, `B64`, `--host`, `--store`; add `httpSlackCall`)
- Test: `everflow/tests/slack-source.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Produces: `export function httpSlackCall(endpoint: OeEndpoint, workspace: string): SlackCall`: chunks of 25 requests, POST `slack` with `{ workspace, requests }`, then the existing per-response handling (`slack.response-json`, `slack.api` with `method:error` reason) unchanged. Methods outside `READ_METHODS` throw `slack.invalid-argument` before any request.

- [ ] **Step 1: Write the failing tests**: request body shape; `ok:false invalid_auth` is `slack.api` reason `conversations.history:invalid_auth`; HTTP 429 passthrough is `slack.api` status 429; 26 requests make 2 calls; `chat.postMessage` throws before any call.
- [ ] **Step 2: Run** `npx vitest run tests/slack-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `httpSlackCall`; `slackMain` uses `oeEndpoint('slack', 'slack')`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `refactor(slack): read slack over https`.

### Task 6: Teams relay through `/everflow/teams`

**Files:**
- Modify: `everflow/src/watchers/relay.ts` (remove `shellQuote`, `sqlLiteral`, `relayCommand`, `relayBatchCommand`, `sshQuery`, `sshBatch`, `serial`, `storeQuery`, `sshRun`, `RelayQuery`, `RelayBatch`, `SshSpawn`; `RelayOptions` keeps `maxRows`, `maxAccounts`; `relayMain` without `--host`, `--data-dir`, `--owner`)
- Test: `everflow/tests/relay-source.test.ts`

**Interfaces:**
- Consumes: Task 3, Task 2 wire format for `teams`.
- Produces:
  - `export type RelaySaved = (floor: number, maxRows: number, signal?: AbortSignal) => Promise<{ slot: number; snapshot?: string; error?: string }[]>`
  - `export function httpRelaySaved(endpoint: OeEndpoint): RelaySaved`: GET `teams` with `since`, `max_rows`; validates `{ slots: [...] }` (else `relay.response-json`).
  - `export async function readRelay(options: RelayOptions, floor: number, signal?: AbortSignal, input?: RelaySaved): Promise<RelaySnapshot>`: same checks and codes as today: no slots is `relay.no-active-accounts`, more than `maxAccounts` is `relay.account-limit`, duplicate or non-numeric slot is `relay.invalid-slot`, a slot `error` is `relay.store-unavailable` for `slot:<n>`, `snapshot` goes through the existing per-slot parsing.

- [ ] **Step 1: Rewrite the tests**: `relayFixture` builds the real SQLite stores as today and answers through a `RelaySaved` fake that runs the same SQL as Task 1 locally (copy of the query in the test file), so the record assertions stay as they are; add `slot error is store-unavailable attributed to the slot`, `endpoint 502 is relay.http-failed` (Review Focus 2), `max_rows + 1 messages is result-limit`. Delete the SSH tests (argv, shell quoting, batch markers, owned SSH child).
- [ ] **Step 2: Run** `npx vitest run tests/relay-source.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `httpRelaySaved` and the new `readRelay`; `relayMain` uses `oeEndpoint('teamsrelay', 'relay')`. `sshRun` moves nowhere: it is deleted.
- [ ] **Step 4: Run** the test. Expected: PASS. `rg -n "sshRun|spawn\\('ssh'" src` returns nothing.
- [ ] **Step 5: Commit** `refactor(relay): read saved teams messages over https`.

### Task 7: Config, runtime, daemon and VM deploy files

**Files:**
- Modify: `everflow/src/core/config.ts` (`oe: z.object({ url: z.string().url(), token_file: z.string().min(1) }).optional()`, `token_file` resolved against the config folder), `src/core/runtime.ts` (`sourceSchema` drops `host`, `data_dir`, `owner`, `store`, adds `oe: boolean` for gmail/gchat; `validateRuntimeConfig`: `teamsrelay`, `oemail`, `slack`, and gmail/gchat with `oe = true` need `[oe]` else `DaemonError('source.oe-required')`, token file readable and non-empty else `source.oe-token`; `sourceCommand` drops `--host`, `--data-dir`, `--owner`, `--store`, adds `--oe` for gmail/gchat, puts `EVERFLOW_OE_URL` and `EVERFLOW_OE_TOKEN` in `environment` only for those sources; kind at line 509 always `cli`; `diagnosticCodes` per Global Constraints), `src/core/daemon.ts:16` (`kind: 'watcher' | 'cli'` for new receipts, `'ssh'` still accepted when reading a receipt at line 85), `tests/inert-watcher.ts` and `tests/runtime-lifecycle.test.ts` (owned child fixture spawned through `cliJson` instead of `sshQuery`), `tests/daemon-pipeline.test.ts:37-49` (expects `['cli','watcher']`), `tests/linux-host.test.ts:75-78` (deleted), `deploy/vm/config.toml` (`[oe]` with `token_file = "oe.token"`, sources without `host`, `data_dir`, `owner`), `deploy/vm/bootstrap.sh` (lines 53-59 removed), `deploy/vm/relay-read.sh` (deleted), `README.md` (SSH sections, `relay-read.sh` row, `host = "local"`, the `[oe]` section and where the token file lives)
- Test: `everflow/tests/runtime.test.ts`, `tests/daemon.test.ts`, `tests/config.test.ts` (whichever hold source config tests)

**Interfaces:**
- Consumes: watcher flags from Tasks 4-6 (`--oe` for gmail/gchat; no transport flags for the others).
- Produces: watcher environment `EVERFLOW_OE_URL`, `EVERFLOW_OE_TOKEN`.

- [ ] **Step 1: Write the failing tests**:
  - `sourceCommand puts the token in the environment, never in args`: `args.join(' ')` does not contain the token; `environment.EVERFLOW_OE_TOKEN` equals the file content trimmed.
  - `teamsrelay without [oe] is source.oe-required`; `empty token file is source.oe-token`; `host in a source is ignored and never passed` (old config keeps loading, looseObject).
  - `a receipt written with an ssh child still reads and stops` (Review Focus 3).
  - `gmail with oe = false keeps the gws CLI path`.
- [ ] **Step 2: Run** those files. Expected: FAIL.
- [ ] **Step 3: Implement** the config, runtime, daemon and test-fixture changes; update `deploy/vm/*` and `README.md`.
- [ ] **Step 4: Run** `npm run typecheck`, then `npx vitest run` for the source, runtime, daemon and config tests, then push and let CI run the full gate (`scripts/gate.ts`). Expected: PASS, CI `Build and test` green. `rg -n -i "ssh" src deploy` lists only the GitHub Actions deploy path (`deploy/vm/receive.sh`, `bootstrap.sh` deploy key).
- [ ] **Step 5: Commit** `refactor(runtime): sources take the oe endpoint from config, ssh removed`.

### Task 8: Rollout and cleanup

No code. Each step verified before the next. Order matters: the endpoint must serve before Everflow switches.

- [ ] **Step 1: Token.** Generate `openssl rand -hex 32`; set it as repository secret `EVERFLOW_TOKEN` on `Aptul9/OE-Copilot` (the `mcp` environment reads it); store it in the vault lockbox `02_Areas/_secrets/everflow.md#OE endpoint token`.
- [ ] **Step 2: OE Copilot PR** `feat/everflow-endpoint` (Tasks 1-2), CI green, merge (own repo, own VM). `teams-relay.yml` and `mcp.yml` deploy. Verify from the laptop: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" https://teams.everbright.it/communication/everflow/teams?since=<now-1h>&max_rows=10` is 200 with 12 slots; `agent` with `/api/communication/accounts` is 200 listing the oemail mailboxes; `slack` with `auth.test` on the configured workspace is 200 `ok:true`; the same calls with `MCP_HTTP_TOKEN` are 401.
- [ ] **Step 3: Everflow PR** `feat/oe-endpoint-sources` (spec, plan, Tasks 3-7), CI green. Before merge: write the token to `~/everflow/instance/oe.token` on oe-vm (`aptul4ever`, mode 600) and to `%LOCALAPPDATA%\everflow\oe.token` (user-only ACL); add `[oe]` to the laptop `config.toml` (backup `config.toml.pre-oe-endpoint`) and drop `host`, `data_dir`, `owner`, `store` from its sources, `oe = true` on gmail and gchat. Merge; the pipeline deploys the VM.
- [ ] **Step 4: Laptop instance.** `scripts/everflow.ps1 stop`, `build`, `start`. Verify both instances: health rows `teamsrelay`, `oemail`, `gmail`, `gchat`, `slack` are `ok` with `last_ok` after the restart; new messages arrive (send a test message on one Teams account and see it on the board); `journalctl -u ssh --since "<restart>" | grep -c 'Accepted publickey for root from 151.'` grows only with this session's own logins, `from 127.0.0.1` stops.
- [ ] **Step 5: oe-vm cleanup** (after Step 4 holds 30 minutes): remove the `everflow-relay` line from `/root/.ssh/authorized_keys` (backup first), `/usr/local/sbin/everflow-relay-read`, `/root/everflow-relay-read.pre-batch`, `~aptul4ever/.ssh/everflow_relay{,.pub}` and the `Host everflow-relay` block in `~aptul4ever/.ssh/config`. Verify `ssh -i ~/.ssh/everflow_relay root@127.0.0.1` no longer exists as a path and every source stays `ok`.
- [ ] **Step 6: Record.** Vault `01_Projects/everflow.md` Log and Traps (SSH traps replaced by the endpoint), Board card moved, daily note.
