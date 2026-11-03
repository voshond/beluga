#!/usr/bin/env bash
# Run this checkout's Beluga (daemon + web gateway) as systemd user services: started at boot,
# restarted when they stop. Run it yourself: bash scripts/linux-dev/install.sh
# After changing code: systemctl --user restart beluga-daemon beluga-web
# A merge into main redeploys by itself (beluga-redeploy.path, redeploy.sh).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
path="$HOME/.local/bin:/usr/local/bin:/usr/bin"
gitdir="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)"

[ -x "$repo/node_modules/.bin/tsx" ] || { echo "Run npm ci in $repo first"; exit 1; }
[ -x "$repo/packages/mac/node_modules/.bin/vite" ] || { echo "Run npm ci in $repo/packages/mac first"; exit 1; }
[ -f "$HOME/.beluga/web.json" ] || echo "Note: no web account yet. Add one: npx tsx src/cli.ts web passwd <name>"

mkdir -p "$units"
for unit in beluga-daemon.service beluga-web.service beluga-redeploy.service beluga-redeploy.path; do
  sed -e "s#@REPO@#$repo#g" -e "s#@PATH@#$path#g" -e "s#@GITDIR@#$gitdir#g" "$repo/scripts/linux-dev/$unit" > "$units/$unit"
done

# Copies started by hand (a terminal, Claude Code) hold the daemon's lock and port 8420.
pkill -f "tsx src/cli.ts (daemon|web)" 2>/dev/null && sleep 2 || true

systemctl --user daemon-reload
systemctl --user enable --now beluga-daemon.service beluga-web.service beluga-redeploy.path
# What runs now is this checkout as it is: the next move of main redeploys.
state="${XDG_STATE_HOME:-$HOME/.local/state}/beluga-dev"
mkdir -p "$state" && git -C "$repo" rev-parse main > "$state/deployed-main"

# Without linger, user services start only once you log in.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "Turning on linger so Beluga starts at boot without a login (may ask for your password)…"
  loginctl enable-linger "$USER" || echo "Run: sudo loginctl enable-linger $USER"
fi

systemctl --user --no-pager status beluga-daemon.service beluga-web.service beluga-redeploy.path | grep -E "●|Active:"
echo "Beluga: http://$(hostname -I 2>/dev/null | awk '{print $1}'):8420"
