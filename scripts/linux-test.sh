#!/bin/sh
# Run tests on Linux, here, in Docker (node:24-bookworm): this checkout mounted at /work, its Linux
# node_modules kept in a named volume (installed again only when package-lock.json changes).
#
#   scripts/linux-test.sh                                   your computers' tests, a real headless Beluga's among them (BLG-783)
#   scripts/linux-test.sh tests/some.test.ts tests/other    any vitest files or folders
#   scripts/linux-test.sh --ubuntu                          Get Ready for real on a fresh Ubuntu, a user without sudo (BLG-842)
#
# BELUGA_LINUX_VOLUME picks another volume (default beluga-linux-test-nm).
set -eu

cd "$(dirname "$0")/.."
volume="${BELUGA_LINUX_VOLUME:-beluga-linux-test-nm}"

# --ubuntu: Get Ready for real (BLG-842) on a fresh Ubuntu 24.04, as a user without sudo: only git,
# curl and the Node that runs the tests (24, copied in; the project asks for another). Uses the
# node_modules the default run installs (run that once first).
if [ "${1:-}" = "--ubuntu" ]; then
  shift
  [ "$#" -gt 0 ] || set -- tests/machines/ready-real.test.ts
  docker build -q -t beluga-ready-ubuntu - >/dev/null <<'DOCKERFILE'
FROM node:24-bookworm-slim AS node
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN useradd -m kay
DOCKERFILE
  exec docker run --rm \
    -v "$PWD":/work \
    -v "$volume":/work/node_modules:ro \
    -w /work \
    --user kay \
    -e CI=1 \
    -e BELUGA_READY_REAL=1 \
    beluga-ready-ubuntu \
    sh -c 'echo "$(. /etc/os-release && echo "$PRETTY_NAME"), $(id -un) (sudo: $(command -v sudo || echo none)), node $(node -v)"; node node_modules/vitest/vitest.mjs run --configLoader=runner "$@"' sh "$@"
fi

[ "$#" -gt 0 ] || set -- tests/machines/ tests/machines- tests/machine-

exec docker run --rm \
  -v "$PWD":/work \
  -v "$volume":/work/node_modules \
  -w /work \
  -e CI=1 \
  -e KLAUD_TEST_SLOTS=1 \
  node:24-bookworm \
  sh -c '
    set -e
    want=$(sha256sum package-lock.json | cut -c1-64)
    if [ "$(cat node_modules/.lock-sha 2>/dev/null)" != "$want" ]; then
      echo "Installing Linux node_modules (once per package-lock.json)…"
      find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
      npm ci --no-audit --no-fund --loglevel=error
      echo "$want" > node_modules/.lock-sha
    fi
    echo "Linux $(uname -r), node $(node -v)"
    npx vitest run "$@"
  ' sh "$@"
