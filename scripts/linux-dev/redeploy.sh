#!/usr/bin/env bash
# Redeploy this checkout's Beluga after main moved (a merge): run by beluga-redeploy.service when
# beluga-redeploy.path sees main change. Beluga's Merge merges inside this checkout, so the new code
# is already here: reinstall packages if a lockfile changed, then restart the daemon and the web
# gateway (which rebuilds the window as it starts).
#   DRY_RUN=1 bash scripts/linux-dev/redeploy.sh    says what it would do, changes nothing
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
state="${XDG_STATE_HOME:-$HOME/.local/state}/beluga-dev"
deployed_file="$state/deployed-main"
dry="${DRY_RUN:-}"
run() { if [ -n "$dry" ]; then echo "would run: $*"; else "$@"; fi; }

# Merges come in bursts (merge, then a fix-up): wait for main to settle.
[ -n "$dry" ] || sleep "${REDEPLOY_SETTLE_SEC:-8}"

cd "$repo"
branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" != main ]; then
  echo "redeploy: this checkout is on $branch, not main: not redeploying"
  exit 0
fi
new="$(git rev-parse main)"
old="$(cat "$deployed_file" 2>/dev/null || true)"
if [ "$new" = "$old" ]; then
  echo "redeploy: main is still ${new:0:8}, already running"
  exit 0
fi
echo "redeploy: main ${old:0:8} -> ${new:0:8}: $(git log -1 --format=%s "$new")"

# Packages: only when a lockfile changed (or nothing was deployed yet and they're missing).
changed() { [ -z "$old" ] || ! git cat-file -e "$old" 2>/dev/null || ! git diff --quiet "$old" "$new" -- "$1"; }
root_deps=""; mac_deps=""
if changed package-lock.json && { [ -n "$old" ] || [ ! -d node_modules ]; }; then root_deps=1; fi
if changed packages/mac/package-lock.json && { [ -n "$old" ] || [ ! -d packages/mac/node_modules ]; }; then mac_deps=1; fi

if [ -n "$root_deps$mac_deps" ]; then
  # Stopped first: npm ci replaces node_modules under the running daemon.
  run systemctl --user stop beluga-web.service beluga-daemon.service
  [ -z "$root_deps" ] || { echo "redeploy: package-lock.json changed: npm ci"; run npm ci --no-audit --no-fund; }
  [ -z "$mac_deps" ] || { echo "redeploy: packages/mac/package-lock.json changed: npm ci"; (cd packages/mac && run npm ci --no-audit --no-fund); }
  run systemctl --user start beluga-daemon.service beluga-web.service
else
  run systemctl --user restart beluga-daemon.service beluga-web.service
fi

if [ -z "$dry" ]; then
  mkdir -p "$state"
  echo "$new" > "$deployed_file"
fi
echo "redeploy: running ${new:0:8}"
