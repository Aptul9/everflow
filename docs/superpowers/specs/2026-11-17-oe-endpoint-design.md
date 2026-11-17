# Everflow reads every source through one OE Copilot endpoint

## Intent

Everflow reads Teams relay, Outlook (oemail), Gmail, Google Chat and Slack data that lives on oe-vm. Today every one of those reads is an SSH login: the laptop instance logs in as root about 8 times a minute (36 before PR 45), the VM instance logs in to itself as root through a forced command (`deploy/vm/relay-read.sh`), and the sources run `docker inspect`, `curl`, `sqlite3` and `jq` on the host. That couples Everflow to a host, a Unix user and a filesystem layout, needs root for the two Teams relay slot folders that are `0700`, and broke the VM relay on 2026-11-17 when the read format changed.

The target: OE Copilot exposes one HTTPS endpoint that serves everything Everflow reads, authenticated with one token. Everflow needs a URL and a token, nothing else, so the same build runs on the laptop, on oe-vm, or in Docker on any PC.

## Goals

- One endpoint between OE Copilot and Everflow: the communication service already published at `https://teams.everbright.it/communication/` (Caddy strips `/communication`, service on `127.0.0.1:8190`, `OE-Copilot/mcp`).
- One bearer token for Everflow, read-only: it can read what the five sources read and nothing else.
- Every Everflow source that today uses SSH reads over that endpoint: `teamsrelay`, `oemail`, `gmail` and `gchat` in their `host` mode, `slack`.
- No SSH, `docker inspect`, remote shell or file access on oe-vm from Everflow, on any instance.
- Removal of everything that existed only for the SSH path: `sshRun`, `relayCommand`, `relayBatchCommand`, `sshBatch`, `oeCommand`, `slackCommand`, the `ssh` child kind in the daemon, `deploy/vm/relay-read.sh`, the root key and `everflow-relay` alias in `deploy/vm/bootstrap.sh`, and the live copies on oe-vm (`/usr/local/sbin/everflow-relay-read`, its line in `/root/.ssh/authorized_keys`, `~aptul4ever/.ssh/everflow_relay*`, the `Host everflow-relay` block).

## Non-goals

- GitHub Actions deploys over SSH and rsync stay as they are (everflow `ci-cd.yml`, OE-Copilot `teams-relay.yml`, `mcp.yml`, `calendar.yml`).
- Unison vault sync is untouched.
- A Docker image for Everflow itself. This work removes the host coupling that blocks one; packaging is a later piece.
- The other SSH uses in OE Copilot: the SSH gateway and token broker of `mcp/ts`, the calendar agent reached through an SSH tunnel, the Teams relay fleet reverse tunnels and embedded ssh2 server. Each is its own later piece, in that order.
- The Gmail and Google Chat modes that run the local `gws`/`gweb` CLI (no `host` in config). They use no SSH and stay.
- Any change to what Everflow ingests: same records, same accounts, same checkpoints, same error codes where the meaning is the same.

## Anti-goals

- The Everflow token can send, edit, react or delete anything. It must be read-only; the existing `MCP_HTTP_TOKEN` (which can write) is not reused.
- The OE Copilot agent, the Teams relay webapp or Slack credentials become reachable from outside oe-vm. They stay on the Docker network; only the communication service talks to them.
- Everflow parses a second format for the same data: the endpoint returns what the current readers already parse, so ingest code keeps working unchanged.
- A source silently returns fewer messages than today (row caps, per-chat windows). A cap that is hit is an error, as today (`relay.result-limit`, `oemail.pagination`).

## Constraints

- Communication service: Rust, hand-written hyper router in `mcp/src/http.rs` that today serves only `/mcp` and `/healthz`, checks `Host` against `MCP_HTTP_HOSTS`, refuses any request with `Origin`, compares the bearer in constant time, 4 MiB request cap. It already holds every backend credential: agent `API_KEY` (`gateway.rs`, fixed endpoint allow-list incl. `/api/communication/{accounts,read,gmail/read,gchat/read}`), Teams relay `/mcp` URL and `MCP_TOKEN` (`teams.rs`), the slackcli store mounted read-only at `/slackcli` (`slack.rs`). Deployed by `mcp.yml` on push to `main` touching `mcp/**`, `.env` from the `mcp` environment.
- Teams relay: Next.js webapp `teams-relay/app`, slot stores `data/<slot>/messages.db`, slot list in `data/app.db` (`teams_accounts`, `"user"`). `/mcp` already accepts `MCP_TOKEN` as the administrator of `.env` (`src/app/mcp/route.ts`, `mcpUserId()`). The webapp process reads every slot store, the `0700` ones included. No route today returns saved messages across slots since a time.
- Everflow readers already isolate transport behind a call type: `OeCall` (`oemail.ts`: list of `{path, body}` to list of `{status, body}`), `OeGoogleRead` on top of `OeCall` (`oe-google.ts`), `SlackCall` (`slack.ts`: list of `{method, params}` to list of parsed bodies, read-only method allow-list `READ_METHODS`), `readRelay` (`relay.ts`, returns `RelaySnapshot`). Tests inject fakes at those seams.
- Watchers are child processes started by the daemon with arguments built in `sourceCommand` (`src/core/runtime.ts`). Command-line arguments are visible in the process list; a token must not travel there.
- Everflow instance config is `config.toml` outside the repo; `deploy/vm/config.toml` in the repo is the VM template. No token in plaintext in a committed file.
- Response sizes: oemail asks up to 32 MiB per call today, the relay batch up to 64 MiB; the communication service's 4 MiB cap applies to request bodies only.

## Approaches

| Approach | What it is | Trade-off |
|---|---|---|
| A. One endpoint on the communication service (chosen) | Communication service gains a read-only REST surface for Everflow; it forwards to agent, Teams relay and Slack over the Docker network | One URL, one token, backends stay private; work in the communication service and the Teams relay |
| B. One endpoint per backend | Teams relay `/api/export`, agent `/api/communication` published through Caddy, Slack through the communication service | Three URLs and tokens in Everflow, agent API exposed to the internet |
| C. Everflow as a client of the existing MCP tools | `email_list`, `chat_*` over `/mcp` | Tools shaped for a model reading a chat window (20 to 40 items, one chat per call); polling through them is fragile and lossy |

Owner chose A ("only one endpoint between oe-copilot, that exposes everything, and everflow").

Inside A, the endpoint forwards the request shapes Everflow already speaks rather than returning one normalized feed. Normalizing would move all five parsers into Rust and change what Everflow ingests; forwarding keeps ingest identical and makes the change a transport swap. Decided by the builder of this design (owner may overrule).

## The endpoint

All routes under the communication service, public as `https://teams.everbright.it/communication/everflow/...`. Same `Host` and `Origin` rules as `/mcp`. Bearer = new `EVERFLOW_TOKEN` (`.env` of the `mcp` environment, at least 32 characters like `MCP_HTTP_TOKEN`); a missing variable turns the routes off (404). `MCP_HTTP_TOKEN` does not open these routes and `EVERFLOW_TOKEN` does not open `/mcp`.

- `POST /everflow/agent`: body `{"requests": [{"path": "...", "body": {...}?}]}`, answer `{"responses": [{"status": 200, "body": "<raw text>"}]}` in the same order. Allowed paths: `/api/communication/accounts`, `/api/communication/read`, `/api/communication/gmail/read`, `/api/communication/gchat/read`. Anything else is refused before any call. Upstream status and body are passed through so Everflow's existing `oemail.http` and Chat `409` handling keep working. Same shape as `OeCall`.
- `POST /everflow/slack`: body `{"workspace": "T...", "requests": [{"method": "...", "params": {...}}]}`, answer `{"responses": [{"status": 200, "body": "<raw text>"}]}`. Methods limited to the current `READ_METHODS` of `slack.ts`. Session from the slackcli store the service already mounts. Same shape as `SlackCall` before parsing.
- `GET /everflow/teams?since=<ms>&max_rows=<n>`: answer = the raw per-slot data the two SSH queries return today, not `RelaySnapshot`: `{"slots": [{"slot": 1, "snapshot": "<the json_object text storeQuery selects>"} | {"slot": 7, "error": "<reason>"}]}` over the active slots of the `MCP_TOKEN` administrator, in slot order. Everflow keeps `normalize()`, the per-slot checks and its error codes (`relay.saved-json`, `relay.scan-state`, `relay.message-time`, `relay.result-limit`, `relay.store-unavailable` for a slot error), so `message_id` and every record stay byte-identical. Served by a new Teams relay route that the communication service calls on the Docker network with the `MCP_TOKEN` it already holds, and passes through unchanged.

Batching limits (number of requests per call, response size) are the builder's, chosen so a full scan of today's accounts fits in one call per source per poll.

## Teams relay route

New route in `teams-relay/app`, reachable on the Docker network (`webapp:8090`), bearer `MCP_TOKEN` only (no session cookie, no OAuth token, no `Origin`, like `/mcp`). It lists slots with the current slot query of `readRelay` (`teams_accounts` joined to `"user"`, `stopped=0`, owner = the `MCP_TOKEN` administrator), opens each slot store read-only in process and runs the exact SQL of `storeQuery` (`relay.ts`): numeric `mid` at or after `since`, ordered, text cut at 2000 characters, `muted` list, `state` keys `me`, `last_scan_ts`, `state`, `max_rows + 1` rows so Everflow detects the cap. A store that fails becomes that slot's `error`; the answer never fails as a whole for one slot. The webapp process can read the `0700` slots, so no root is involved.

Owner today: `owner = "aptul99@gmail.com"` on both instances (laptop `%LOCALAPPDATA%\everflow\config.toml:47`, VM `deploy/vm/config.toml:59`), and the Teams relay `ADMIN_EMAIL` (GitHub variable `vars.ADMIN_EMAIL`, live in `teams-webapp`) is `aptul99@gmail.com`, checked 2026-11-17. Keying on the `MCP_TOKEN` administrator therefore reads the same slots as today, and `owner` leaves the Everflow config. Whether it is also reachable through the public Teams relay Caddy is the builder's call; Everflow never calls it directly.

## Everflow side

- New top-level config: `[oe] url = "https://teams.everbright.it/communication"` and the token from an environment variable named in config (`token_env = "EVERFLOW_OE_TOKEN"`), or a file path for the VM systemd unit. The daemon passes the token to watchers through their environment, never through arguments.
- `teamsrelay`, `oemail`, `slack` lose `host`; `teamsrelay` loses `data_dir` and `owner` (the token decides whose slots). `gmail` and `gchat` keep the CLI mode; their `host` mode becomes "through `[oe]`" (a boolean or the presence of `[oe]`: builder's call). Config validation in `validateRuntimeConfig` follows.
- HTTP implementations of `OeCall`, `SlackCall` and the relay reads (slot list and store snapshots, which `readRelay` today gets from two SSH sessions, now one GET) replace the SSH ones. Parsing, normalizing, checkpoints and state machines stay. Transport error codes keep their meaning: `*.ssh-failed` becomes `*.http-failed` (network or non-2xx from the endpoint itself), `*.timeout`, `*.result-limit`, `*.aborted` stay; new codes go into the `diagnosticCodes` list in `runtime.ts`.
- The daemon's `ssh` child kind and its registration in `runtime.ts` go away with the SSH spawns.
- `deploy/vm/config.toml`, `deploy/vm/bootstrap.sh`, the VM systemd unit and README sections describing SSH, `everflow-relay`, `relay-read.sh` and `host = "local"` are updated or removed.

## Rollout

1. Teams relay route, deployed by `teams-relay.yml`.
2. Communication service routes and `EVERFLOW_TOKEN` in the `mcp` environment, deployed by `mcp.yml`; checked with `curl` from the laptop against the public URL for each route.
3. Everflow change; laptop instance gets `[oe]` and the token, VM instance gets it through the pipeline secrets. Both instances verified: every source `ok`, records still arriving, `journalctl -u ssh` on oe-vm shows no Everflow logins.
4. Cleanup on oe-vm: remove the forced command, the root key line, the relay key pair and the `everflow-relay` alias. The `sshd` hardening of 2026-11-17 stays.

## Left to the builder

- Rust module layout in the communication service and the Teams relay route's path and file.
- Batch sizes, timeouts and response caps, within the rule that a full scan of today's accounts is one call per source per poll.
- How the VM unit receives the token (pipeline secret into an env file next to `login.env` is the obvious path).
- Test layout: Rust tests against fake backends like `tests/server.rs`, Teams relay route tests like `mcp-route.test.ts`, Everflow transport tests at the existing seams.
