#!/bin/sh
# Forced command of the aptul4ever relay key in /root/.ssh/authorized_keys (restrict,from="127.0.0.1",command=...).
# Some relay slot folders are root-only (0700), so the relay source reads as root, as the laptop does over SSH. Only the
# read-only sqlite3 call that relayCommand builds, on a store under /opt/teamsrelay/data, is run: alone, or as the
# stores of one relayBatchCommand, each checked the same way before any runs.
set -euf
c=${SSH_ORIGINAL_COMMAND:-}
case $c in *"
"*) echo "single line only" >&2; exit 2 ;; esac
check() {
  case $1 in
    "'sqlite3' '-readonly' '-json' '/opt/teamsrelay/data/"*) ;;
    *) echo "only read-only sqlite3 on the relay stores" >&2; exit 2 ;;
  esac
  case $1 in *"/../"*) echo "no traversal" >&2; exit 2 ;; esac
}
open='{ ' close=" || printf '\\025'; }; printf '\\036'"
case $c in
  "$open"*) ;;
  *) check "$c"; eval "exec $c" ;;
esac
rest=$c
while [ -n "$rest" ]; do
  case $rest in "$open"*) ;; *) echo "malformed batch" >&2; exit 2 ;; esac
  rest=${rest#"$open"}; q=${rest%%"$close"*}
  [ "$q" != "$rest" ] || { echo "malformed batch" >&2; exit 2; }
  check "$q"
  rest=${rest#"$q$close"}; rest=${rest#"; "}
done
rest=$c
while [ -n "$rest" ]; do
  rest=${rest#"$open"}; q=${rest%%"$close"*}; rest=${rest#"$q$close"}; rest=${rest#"; "}
  # exec ends the subshell at the store query, as in the single form
  (eval "exec $q") || printf '\025'
  printf '\036'
done
