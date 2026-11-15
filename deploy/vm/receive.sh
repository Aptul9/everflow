#!/bin/sh
# Forced command of the pipeline deploy key in ~aptul4ever/.ssh/authorized_keys (restrict,command=".../everflow-receive").
# stdin: `git archive` tar.gz of the commit. SSH_ORIGINAL_COMMAND: "<commit sha> <archive sha256> <user, base64> <bcrypt hash, base64>".
# Builds the commit on the VM, installs the instance files from deploy/vm, pins the new build and restarts the daemon; when the
# page does not answer after the restart the previous build is pinned again and the deploy fails.
set -euf
umask 022
export PATH="$HOME/.local/lib/node26/bin:/usr/local/bin:/usr/bin:/bin"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
root=$HOME/everflow
instance=$root/instance
mkdir -p "$root/incoming" "$root/releases" "$instance" "$root/caddy" "$HOME/.local/bin" "$HOME/.config/systemd/user"
exec 9> "$root/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 75; }

set -- ${SSH_ORIGINAL_COMMAND:-}
[ "$#" -eq 4 ] || { echo "usage: <commit> <sha256> <user-b64> <hash-b64>" >&2; exit 2; }
commit=$1 sum=$2 user_b64=$3 hash_b64=$4
printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || { echo "invalid commit" >&2; exit 2; }
printf '%s' "$sum" | grep -Eq '^[0-9a-f]{64}$' || { echo "invalid sha256" >&2; exit 2; }
user=$(printf '%s' "$user_b64" | base64 -d) hash=$(printf '%s' "$hash_b64" | base64 -d)
printf '%s' "$user" | grep -Eq '^[A-Za-z0-9._@+-]{1,128}$' || { echo "invalid user" >&2; exit 2; }
printf '%s' "$hash" | grep -Eq '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' || { echo "invalid bcrypt hash" >&2; exit 2; }
# the client-supplied words are parsed; globbing is needed again for the cleanup below
set +f
command -v node >/dev/null && [ "$(node -v)" = "v26.4.0" ] || { echo "Node v26.4.0 missing in ~/.local/lib/node26 (deploy/vm/bootstrap.sh)" >&2; exit 1; }

echo "[$(date -u +%FT%TZ)] deploy $commit"
archive=$root/incoming/$commit.tar.gz
head -c 67108864 > "$archive.part"
echo "$sum  $archive.part" | sha256sum -c --status || { rm -f "$archive.part"; echo "sha256 mismatch: archive discarded" >&2; exit 1; }
mv -f "$archive.part" "$archive"

release=$root/releases/$commit
rm -rf "$release.new" && mkdir -p "$release.new"
tar xzf "$archive" -C "$release.new"
rm -rf "$release" && mv "$release.new" "$release" && rm -f "$archive"

# source-only staged build, as on the laptop; its receipt path is the last JSON line
build_log=$root/build-$commit.log
(cd "$release" && node scripts/build.ts) > "$build_log" 2>&1 || { tail -20 "$build_log" >&2; echo "build failed" >&2; exit 1; }
receipt=$(sed -n 's/^{"buildReceipt":"\(.*\)"}$/\1/p' "$build_log" | tail -n 1)
[ -f "$receipt" ] || { echo "build wrote no receipt" >&2; exit 1; }
echo "built $receipt"

vm=$release/deploy/vm
install -m 644 "$vm/config.toml" "$instance/config.toml"
install -m 644 "$vm/providers.jsonc" "$instance/providers.jsonc"
mkdir -p "$HOME/everflow-chats/roar"
install -m 755 "$vm/run.sh" "$HOME/.local/bin/everflow-run"
install -m 644 "$vm/everflow.service" "$HOME/.config/systemd/user/everflow.service"
systemctl --user daemon-reload
systemctl --user enable everflow.service >/dev/null 2>&1

domain=$(sed -n 's|^public_origin = "https://\([^"]*\)"$|\1|p' "$instance/config.toml")
[ -n "$domain" ] || { echo "config.toml has no [web] public_origin" >&2; exit 1; }
install -m 644 "$vm/Caddyfile" "$root/caddy/Caddyfile"
install -m 644 "$vm/compose.yml" "$root/caddy/compose.yml"
# single quotes: compose takes the bcrypt '$' literally
(umask 077; printf "EVERFLOW_DOMAIN='%s'\nEVERFLOW_USER='%s'\nEVERFLOW_HASH='%s'\n" "$domain" "$user" "$hash" > "$root/caddy/.env")
docker compose -f "$root/caddy/compose.yml" up -d --remove-orphans

previous=$(cat "$instance/build.txt" 2>/dev/null || true)
printf '%s\n' "$receipt" > "$instance/build.txt"
healthy() {
  i=0
  while [ "$i" -lt 45 ]; do
    i=$((i + 1)); sleep 2
    systemctl --user is-active --quiet everflow.service || continue
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:8789/api/state)" = 200 ] && return 0
  done
  return 1
}
systemctl --user restart everflow.service
if ! healthy; then
  journalctl --user -u everflow.service -n 30 --no-pager >&2 || true
  if [ -n "$previous" ] && [ -f "$previous" ]; then
    printf '%s\n' "$previous" > "$instance/build.txt"
    systemctl --user restart everflow.service
    healthy && echo "rolled back to $previous" >&2 || echo "rollback to $previous did not answer either" >&2
  fi
  echo "new build did not answer on 127.0.0.1:8789" >&2
  exit 1
fi
echo "live $receipt"

# the next deploy runs the receive logic of this commit
install -m 755 "$vm/receive.sh" "$HOME/.local/bin/everflow-receive"

# keep the running and the previous build, and the three newest releases
for build in "$HOME"/.local/share/everflow/source-builds/build-*; do
  [ -d "$build" ] || continue
  case "$receipt $previous" in *"$build/"*) continue ;; esac
  rm -rf "$build"
done
ls -1dt "$root"/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
ls -1t "$root"/build-*.log 2>/dev/null | tail -n +4 | xargs -r rm -f
echo "[$(date -u +%FT%TZ)] done $commit"
