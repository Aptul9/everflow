#!/bin/sh
# One-time root setup of oe-vm for the Everflow instance; everything after it comes from the pipeline (receive.sh).
# Run as root from a checkout: sh deploy/vm/bootstrap.sh "<deploy public key>"  (ssh-ed25519 AAAA... everflow-deploy@github-actions)
# Idempotent: a second run changes nothing that is already in place.
set -eu
user=aptul4ever
home=/home/$user
# names Caddy serves on $port: the page, then the OpenChamber web UI behind its sign-in
names="flow.everbright.it chat.flow.everbright.it"
port=4449
node=v26.4.0
key=${1:?deploy public key required}
here=$(cd "$(dirname "$0")" && pwd)
printf '%s' "$key" | grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+ [A-Za-z0-9@._-]+$' || { echo "expected one ssh-ed25519 public key" >&2; exit 2; }

# docker: receive.sh runs the Caddy compose
id -nG "$user" | tr ' ' '\n' | grep -qx docker || usermod -aG docker "$user"

# Node of the build and the daemon, verified against the release checksums; the Linux build links libatomic
dpkg -s libatomic1 >/dev/null 2>&1 || DEBIAN_FRONTEND=noninteractive apt-get install -y -q libatomic1 >/dev/null
if [ "$(sudo -u "$user" "$home/.local/lib/node26/bin/node" -v 2>/dev/null)" != "$node" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$node/node-$node-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$node/SHASUMS256.txt"
  (cd "$tmp" && grep " node-$node-linux-x64.tar.xz\$" SHASUMS256.txt | sed 's/node-.*/node.tar.xz/' | sha256sum -c --status)
  chmod 755 "$tmp" && chmod 644 "$tmp/node.tar.xz"
  sudo -u "$user" mkdir -p "$home/.local/lib"
  sudo -u "$user" tar xJf "$tmp/node.tar.xz" -C "$home/.local/lib"
  sudo -u "$user" ln -sfn "node-$node-linux-x64" "$home/.local/lib/node26"
  rm -rf "$tmp"
fi

# sslh: these names to the Everflow Caddy, ahead of the catch-all that sends unnamed TLS to teams-caddy. Lines for earlier
# names stay (Caddy redirects them). The missing names go on one new line, with one backup per run that changes the file
# (never overwriting an earlier one, such as .pre-everflow) and at most one restart.
missing=
for name in $names; do grep -qF "\"$name\"" /etc/sslh.cfg || missing="$missing${missing:+, }\"$name\""; done
if [ -n "$missing" ]; then
  backup=/etc/sslh.cfg.pre-everflow-$(date -u +%Y%m%dT%H%M%SZ)
  cp -p /etc/sslh.cfg "$backup"
  awk -v line="    { name: \"tls\"; host: \"127.0.0.1\"; port: \"$port\"; sni_hostnames: [ $missing ]; }," '
    !done && /name: "tls"; host: "127.0.0.1"; port: "4443"; }/ { print line; done = 1 } { print }' "$backup" > /etc/sslh.cfg
  for name in $names; do
    grep -qF "\"$name\"" /etc/sslh.cfg || { cp -p "$backup" /etc/sslh.cfg; echo "sslh catch-all line not found" >&2; exit 1; }
  done
  if ! systemctl restart sslh || ! systemctl is-active --quiet sslh; then
    cp -p "$backup" /etc/sslh.cfg && systemctl restart sslh
    echo "sslh did not start with the new line: previous config restored" >&2; exit 1
  fi
fi

# the pipeline key can only run the receive script
install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
install -d -m 755 -o "$user" -g "$user" "$home/.local/bin"
install -m 755 -o "$user" -g "$user" "$here/receive.sh" "$home/.local/bin/everflow-receive"
line="restrict,command=\"$home/.local/bin/everflow-receive\" $key"
blob=$(printf '%s' "$key" | cut -d' ' -f2)
grep -qF "$blob" "$home/.ssh/authorized_keys" 2>/dev/null || printf '%s\n' "$line" | sudo -u "$user" tee -a "$home/.ssh/authorized_keys" >/dev/null
chmod 600 "$home/.ssh/authorized_keys"
echo "bootstrap ok: docker group, node $node, sslh $names -> 127.0.0.1:$port, deploy key"
