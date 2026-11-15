#!/bin/sh
# ExecStart of everflow.service: the daemon in the foreground (the CLI's own `_run`), on the build pinned in build.txt.
# A new run id per start, as `everflow start` would give it.
set -eu
instance=$HOME/everflow/instance
receipt=$(cat "$instance/build.txt")
exec node "$(dirname "$receipt")/dist/cli.js" --artifact "$receipt" --config "$instance/config.toml" _run --run-id "$(cat /proc/sys/kernel/random/uuid)"
