#!/bin/sh
# Forced command of the aptul4ever relay key in /root/.ssh/authorized_keys (restrict,from="127.0.0.1",command=...).
# Some relay slot folders are root-only (0700), so the relay source reads as root, as the laptop does over SSH. Only the
# read-only sqlite3 call that relayCommand builds, on a store under /opt/teamsrelay/data, is run.
set -euf
c=${SSH_ORIGINAL_COMMAND:-}
case $c in
  *"
"*) echo "single line only" >&2; exit 2 ;;
  "'sqlite3' '-readonly' '-json' '/opt/teamsrelay/data/"*) ;;
  *) echo "only read-only sqlite3 on the relay stores" >&2; exit 2 ;;
esac
case $c in *"/../"*) echo "no traversal" >&2; exit 2 ;; esac
eval "exec $c"
