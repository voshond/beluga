#!/usr/bin/env bash
# Install this checkout's thin client on arch (x86_64, built here) and m1arch (aarch64, built there), side by side.
# Run on i9arch: bash scripts/deploy-thin-clients.sh [arch] [m1arch]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tauri="packages/mac/src-tauri"
logs="$repo/.beluga/scratch/deploy"
hosts=("$@")
[ $# -eq 0 ] && hosts=(arch m1arch)
mkdir -p "$logs"

remote() {
  ssh -o BatchMode=yes "$1" "zsh -lc $(printf '%q' "$2")"
}

link_app() {
  remote "$1" 'mkdir -p ~/.local/bin && ln -sf ~/.local/opt/beluga/bin/beluga-mac ~/.local/bin/beluga-app'
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

declare -A pids
for host in "${hosts[@]}"; do
  case "$host" in
    arch) deploy_arch >"$logs/arch.log" 2>&1 & ;;
    m1arch) deploy_m1arch >"$logs/m1arch.log" 2>&1 & ;;
    *) echo "Unknown host $host (arch or m1arch)"; exit 1 ;;
  esac
  pids[$host]=$!
  echo "$host: deploying, log in $logs/$host.log"
done

failed=0
for host in "${!pids[@]}"; do
  if wait "${pids[$host]}"; then
    echo "$host: $(tail -n 1 "$logs/$host.log")"
  else
    echo "$host: FAILED, last lines of $logs/$host.log:"
    tail -n 20 "$logs/$host.log"
    failed=1
  fi
done
exit "$failed"
