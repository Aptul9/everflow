# Everflow Google sources implementation plan

## Steps

- [x] Add tested gweb background-read opt-out and authenticated self id.
- [x] Add bounded CLI runner and Google Chat/Gmail watchers, with failing tests first.
- [x] Wire source validation, ingest, checkpoints, health, lifecycle and quiet windows.
- [x] Rename product and update documentation sources and generated guide.
- [x] Run staged typechecks, regression suite and real read-only scratch collection.
- [x] Record evidence, review diff and close project task.

## Constraints

Approved design: `docs/superpowers/specs/2026-11-07-everflow-google-sources-design.md`. Execute inline. No subagents, live activation, held-state access, migration, browser activation, external messages or source read-state changes. Preserve checkout/runtime paths and compatibility identifiers. No new application dependencies. Build and test only through source-only stages.

Approved amendment: API-first session renewal, explicit minimized-profile bootstrap without focus/prompts, and test-first native exit-race repair. These are the only exceptions to the original browser-start restriction. Source activation and live runtime changes remain excluded.

## File map

- `gweb/cmd/gweb/main.go`: chat `--no-refresh` flag and additive `self_id` in read JSON; command tests and README document behavior.
- `src/watchers/cli-json.ts`: shared bounded, cancellable, tracked JSON subprocess reads.
- `src/watchers/gchat.ts`: recent-topic Google Chat normalization, identity validation and observation-only checkpoints.
- `src/watchers/gmail.ts`: Gmail profile verification, paginated Inbox/Sent reads and MIME normalization.
- `src/watchers/source.ts`, `src/core/runtime.ts`, `src/core/daemon.ts`, `src/core/ingest.ts`, `src/core/config.ts`: new source contracts and existing runtime integration.
- `tests/google-sources.test.ts`, `tests/cli-json.test.ts`, runtime/source/README tests: failure, deduplication, scheduling, subprocess and documentation contracts.
- `package.json`, `package-lock.json`, CLI help, page metadata/header: Everflow identity, legacy npm alias retained.
- `config.toml`, `README.md`, `docs/guide/`: source configuration, prerequisites, limits, renamed guide and regenerated outputs.

## Verification sequence

1. Add tests, prepare source-only stage and install its private dependencies with `scripts/setup.ts`. Run focused Vitest checks and retain missing-feature failures.
2. Implement minimal source adapters. Repeat focused checks on staged source until green. Verify gweb tests with `go test ./cmd/gweb ./internal/store` before building its installed executable.
3. Build final candidate with `npm run build`. Read completed receipt. Set `TEST_BUILD_RECEIPT`, `EVERFLOW_ARTIFACT` and fresh `TEST_TRACKED_LEGACY_PATHS`, then run both typechecks and full Vitest under `isolatedEnvironment`.
4. Run compiled Google watchers once against existing CLI authentication, ingest NDJSON into a fresh owned SQLite instance, schedule synthetic-age batches, reopen and replay to prove deduplication. Tickets/chats remain disabled for live reads. Compare Gmail labels and Chat unread counts around reads.
5. Generate diagrams from JSON, validate/deliver, regenerate guide from Markdown and inspect document contents. Record commands, counts and limitations in project log and daily note; move only this task's Board card.
