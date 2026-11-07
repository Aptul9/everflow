# Workdesk Google sources

## Approved scope

Product name: Workdesk. Owner approved name and scope through the local choice form on 2026-11-07. Product, package, CLI help, page and current documentation adopt that name. Checkout, GitHub repository, instance directories, database names, named-pipe namespace and existing environment variables remain compatible. No live restart, migration or default-branch merge.

## Sources

Two TypeScript watchers feed the existing NDJSON ingest, durable jobs, tickets and health pipeline. Sources remain disabled by default. Google Chat uses the installed gweb executable with browser refresh disabled. Gmail uses the installed gws executable and its current authentication. Commands run without a shell, with bounded output and time, cancellation and owned-child tracking. Raw subprocess stderr never reaches stored diagnostics.

Google Chat requires an explicit account and expected Google user id. Additive gweb read JSON exposes authenticated self id; mismatches fail closed. Conversations use source-native ids, messages retain thread and attachment/link annotations. Topic and reply limits prevent full-history claims. Successful reads publish recent-topic coverage and observation time without advancing a completeness cursor. No attachment download or source write.

Gmail verifies the authenticated profile against the configured account. Paginated Inbox/Sent searches overlap by two minutes and retrieve full messages through GET calls. MIME traversal prefers plain text, converts HTML when needed and records attachment metadata without fetching binaries. Gmail thread ids group conversations; native message ids deduplicate replays. Sent messages and matching From addresses identify own replies. A failed page or message prevents checkpoint publication. Read state and labels remain untouched.

Quiet windows: Gmail 300 seconds, Google Chat 120 seconds. New sources reuse ticket approval, own-only batching, quarantine, restart and source health behavior. Synthetic checks and read-only scratch collection do not activate sources in an existing instance.

## Documentation and proof

Update root README, example config, reader guide, Word generator and diagram JSON sources. Regenerate Word, HTML and PNG outputs. Test parsers, pagination, authentication mismatches, bounded child execution, failures, restart deduplication and ingestion/scheduling. Run both typechecks and full Vitest suite from a completed source-only stage. Prove real Google reads through compiled watchers into scratch SQLite, with tickets/chats disabled. Preserve historical safety boundaries and original evidence.

## Approved amendment

Owner additionally approved API-first authentication recovery with minimized saved-profile fallback, and repair of the existing Windows child-exit wait race found by the full gate. HTTP cookie rotation is followed by the real read; no mocked result represents authentication success. Browser fallback is an explicit literal `browser_refresh = true` source option, off when absent. It uses the saved profile and zero interactive sign-in wait. Source flags remain disabled. A revoked session remains a visible failure. Browser bootstrap may take up to a 240-second child budget.

The native repair permits bounded waiting when the same process creation identity loses its image before exit signaling. Termination still requires its full original identity and receives no relaxed check.
