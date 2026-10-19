#!/bin/sh
# Copies the Nuvio Remote daemon to a rooted webOS TV and (re)starts it.
#
#   remote/daemon/install/deploy.sh <tv-ip> [ssh-port]
#
# Needs root SSH on the TV (Homebrew Channel -> Settings -> SSH Server).
set -eu

TV="${1:?usage: deploy.sh <tv-ip> [ssh-port]}"
PORT="${2:-22}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$(dirname "$HERE")"
SSH="ssh -p $PORT -o ConnectTimeout=8 root@$TV"

echo "==> copying daemon to $TV"
tar -C "$DAEMON" -cf - main.js package.json lib | $SSH '
  set -e
  mkdir -p /var/lib/nuvio-remote/daemon /var/lib/webosbrew/init.d
  rm -rf /var/lib/nuvio-remote/daemon/lib
  tar -xf - -C /var/lib/nuvio-remote/daemon
'
$SSH 'cat > /var/lib/webosbrew/init.d/nuvio-remote && chmod 755 /var/lib/webosbrew/init.d/nuvio-remote' \
  < "$HERE/nuvio-remote"

echo "==> restarting"
$SSH '/var/lib/webosbrew/init.d/nuvio-remote restart; sleep 2; /var/lib/webosbrew/init.d/nuvio-remote status'

echo "==> reachability"
if command -v curl > /dev/null; then
  curl -s --max-time 5 "http://$TV:47800/" || echo "HTTP check failed"
fi
