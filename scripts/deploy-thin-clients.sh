#!/usr/bin/env bash
# Install this checkout's thin client on arch (x86_64, built here) and m1arch (aarch64, built there), side by side,
# then quit the running Beluga on each and open the new build.
# Run on i9arch: bash scripts/deploy-thin-clients.sh [--no-restart | --restart-only] [arch] [m1arch]
#   --no-restart     install only, leave the running app alone
#   --restart-only   skip build and install, only quit and reopen the app
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri="packages/mac/src-tauri"
logs="$repo/.beluga/scratch/deploy"
mode=deploy
while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) mode=install; shift ;;
    --restart-only) mode=restart; shift ;;
    --*) echo "Unknown option $1 (--no-restart or --restart-only)"; exit 1 ;;
    *) break ;;
  esac
done
hosts=("$@")
[ $# -eq 0 ] && hosts=(arch m1arch)
mkdir -p "$logs"

remote() {
  ssh -o BatchMode=yes "$1" "zsh -lc $(printf '%q' "$2")"
}

link_app() {
  remote "$1" 'mkdir -p ~/.local/bin && ln -sf ~/.local/opt/beluga/bin/beluga-mac ~/.local/bin/beluga-app'
}

# Quit gently, give it 10s, then force it. systemd-run starts the new build in the user's
# graphical session, so it outlives this SSH session.
restart_app() {
  remote "$1" '
    pkill -x beluga-mac || true
    for i in {1..20}; do pgrep -x beluga-mac >/dev/null || break; sleep 0.5; done
    pkill -9 -x beluga-mac || true
    systemd-run --user --collect --quiet ~/.local/opt/beluga/bin/beluga-mac'
  echo "Beluga restarted on $1"
}

deploy_arch() {
  cd "$repo"
  npm run build
  node scripts/build-sidecar.mjs
  (cd packages/mac && npx tauri build --no-bundle)
  remote arch 'mkdir -p ~/.cache/beluga-thin-stage'
  rsync -aR --delete \
    ./scripts/install-linux-app.sh \
    "./$tauri/icons" \
    "./$tauri/target/release/beluga-mac" \
    "./$tauri/binaries/beluga-node-x86_64-unknown-linux-gnu" \
    "./$tauri/resources/daemon" \
    arch:.cache/beluga-thin-stage/
  remote arch 'cd ~/.cache/beluga-thin-stage && bash scripts/install-linux-app.sh'
  link_app arch
}

deploy_m1arch() {
  cd "$repo"
  rsync -a --delete \
    --exclude .git --exclude node_modules --exclude target --exclude dist \
    --exclude .beluga --exclude "$tauri/binaries" \
    ./ m1arch:.cache/beluga-thin-build/
  remote m1arch 'cd ~/.cache/beluga-thin-build && bash scripts/install-linux-app.sh --build'
  link_app m1arch
}

run_host() {
  # Plain ifs, not ||: set -e is off inside a || list, so a failed build would carry on.
  if [ "$mode" != restart ]; then "deploy_$1"; fi
  if [ "$mode" != install ]; then restart_app "$1"; fi
}

declare -A pids
for host in "${hosts[@]}"; do
  case "$host" in
    arch|m1arch) run_host "$host" >"$logs/$host.log" 2>&1 & ;;
    *) echo "Unknown host $host (arch or m1arch)"; exit 1 ;;
  esac
  pids[$host]=$!
  echo "$host: ${mode}ing, log in $logs/$host.log"
done

ok=(); bad=()
for host in "${!pids[@]}"; do
  if wait "${pids[$host]}"; then
    echo "$host: $(tail -n 1 "$logs/$host.log")"
    ok+=("$host")
  else
    echo "$host: FAILED, last lines of $logs/$host.log:"
    tail -n 20 "$logs/$host.log"
    bad+=("$host")
  fi
done

# The Toolbox shows this line as the run's result (docs/toolbox.md).
declare -A done_word=([deploy]="Deployed and restarted on" [install]="Installed on" [restart]="Restarted on")
if [ ${#bad[@]} -eq 0 ]; then
  echo "::beluga status=success ${done_word[$mode]} ${ok[*]}"
  exit 0
fi
echo "::beluga status=fail Failed on ${bad[*]}${ok[*]:+ (ok on ${ok[*]})}"
exit 1
