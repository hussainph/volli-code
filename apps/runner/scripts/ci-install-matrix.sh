#!/usr/bin/env bash
# Linux CI only. Build once, then install the real artifact in clean distro
# containers as both uid modes. No backend, credentials or running daemon.
# Caller supplies the runner release asset directory (both tarballs and their sidecars).
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
  for downloader in curl wget; do
    image="volli-install-${distro//[:.]/-}-$downloader"
    docker build --build-arg "DISTRO=$distro" --build-arg "DOWNLOADER=$downloader" --tag "$image" - <<'DOCKERFILE'
ARG DISTRO
FROM ${DISTRO}
ARG DOWNLOADER
RUN if command -v apt-get >/dev/null; then \
      apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates "$DOWNLOADER" tar gzip coreutils git passwd util-linux; \
    else dnf install -y --allowerasing ca-certificates "$DOWNLOADER" tar gzip coreutils git shadow-utils util-linux; fi \
    && if [ "$DOWNLOADER" = wget ] && command -v curl >/dev/null; then rm -f "$(command -v curl)"; fi \
    && useradd --create-home --shell /bin/sh matrix-user
DOCKERFILE
    for mode in system user; do
      echo "=== install.sh: $distro / $mode / $downloader"
      docker run --rm --network host -e TEST_MODE="$mode" -e TEST_PORT="$port" \
        -e TEST_DOWNLOADER="$downloader" "$image" sh -eu -c '
        if [ "$TEST_DOWNLOADER" = wget ]; then
          ! command -v curl >/dev/null || { echo "wget-only image unexpectedly has curl" >&2; exit 1; }
          fetch="wget -qO-"
        else fetch="curl -fsSL"; fi
        command="$fetch http://127.0.0.1:$TEST_PORT/volli-runner-install.sh | sh -s -- --release-base http://127.0.0.1:$TEST_PORT --no-start --no-link"
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
done
# Real musl and pre-baseline glibc refusals. Match the diagnostic too: a failed
# network download must not masquerade as an unsupported-platform success.
docker run --rm --network host -e TEST_PORT="$port" alpine:3.21 sh -eu -c '
  wget -qO /tmp/install.sh "http://127.0.0.1:$TEST_PORT/volli-runner-install.sh"
  if sh /tmp/install.sh > /tmp/result 2>&1; then cat /tmp/result; exit 1; fi
  cat /tmp/result
  grep -q "musl/non-glibc" /tmp/result
  test "$(wc -l < /tmp/result)" -eq 1
'
docker run --rm --network host -e TEST_PORT="$port" ubuntu:18.04 sh -eu -c '
  apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  curl -fsSL "http://127.0.0.1:$TEST_PORT/volli-runner-install.sh" -o /tmp/install.sh
  if sh /tmp/install.sh --release-base "http://127.0.0.1:$TEST_PORT" > /tmp/result 2>&1; then cat /tmp/result; exit 1; fi
  cat /tmp/result
  grep -q "glibc >= 2.31 is required" /tmp/result
'
echo 'Install matrix passed: six supported distros, root and user, curl and wget; musl and old glibc refused.'
