#!/usr/bin/env bash
# Linux CI only. Build once, then install the real artifact in clean distro
# containers as both uid modes. No backend, credentials or running daemon.
# Caller supplies the C4 asset directory (both tarballs and their sidecars).
set -euo pipefail
assets="${1:?Usage: ci-install-matrix.sh <runner-assets-dir>}"
repo=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d)
server=
cleanup() {
  if [[ -n "$server" ]]; then kill "$server" 2>/dev/null || true; wait "$server" || true; fi
  rm -rf "$work"
}
trap cleanup EXIT
mkdir "$work/release"
cp "$assets"/volli-runner-*.tar.gz "$assets"/volli-runner-*.tar.gz.sha256 "$work/release/"
# --network host makes this same loopback origin reachable inside the containers.
port="${RUNNER_INSTALL_TEST_PORT:-18765}"
node "$repo/scripts/runner-release-manifest.mjs" --assets "$work/release" \
  --release-base "http://127.0.0.1:$port"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/release" >"$work/server.log" 2>&1 &
server=$!
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$port/volli-runner-manifest.json" >/dev/null; then break; fi
  kill -0 "$server" || { cat "$work/server.log"; exit 1; }
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$port/volli-runner-manifest.json" >/dev/null
# No shell expansion of a caller-controlled distro list. Each supported image is
# explicit, and no image gets mounted host directories or a privileged runtime.
for distro in ubuntu:20.04 ubuntu:22.04 ubuntu:24.04 debian:11 debian:12 fedora:41; do
  image="volli-install-${distro//[:.]/-}"
  docker build --build-arg "DISTRO=$distro" --tag "$image" - <<'DOCKERFILE'
ARG DISTRO
FROM ${DISTRO}
RUN if command -v apt-get >/dev/null; then \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates curl tar gzip coreutils git passwd util-linux; \
    else dnf install -y ca-certificates curl tar gzip coreutils git shadow-utils util-linux; fi \
    && useradd --create-home --shell /bin/sh matrix-user
DOCKERFILE
  for mode in system user; do
    echo "=== install.sh: $distro / $mode"
    docker run --rm --network host -e TEST_MODE="$mode" -e TEST_PORT="$port" "$image" sh -eu -c '
      command="curl -fsSL http://127.0.0.1:$TEST_PORT/volli-runner-install.sh | sh -s -- --release-base http://127.0.0.1:$TEST_PORT --no-start --no-link"
      if [ "$TEST_MODE" = system ]; then
        sh -eu -c "$command"
        /usr/local/bin/volli-runner version
      else
        su - matrix-user -s /bin/sh -c "$command"
        su - matrix-user -s /bin/sh -c '\''"$HOME/.local/bin/volli-runner" version'\''
      fi
    '
  done
done
echo 'Install matrix passed: Ubuntu 20.04/22.04/24.04, Debian 11/12, Fedora 41; root and user.'
