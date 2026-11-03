#!/bin/sh
# `beluga` on a server (scripts/build-server.mjs puts this in the bundle's bin/): runs Beluga's
# engine with the Node that came with it. Linked from ~/.local/bin, so it finds its folder first.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
root=$(cd "$(dirname "$self")/.." && pwd)
BELUGA_SERVER_ROOT=$root
export BELUGA_SERVER_ROOT
exec "$root/node/node" "$root/daemon/dist/cli.js" "$@"
