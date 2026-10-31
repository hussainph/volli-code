#!/bin/bash
# A small CI-only installer lane; no backend/online/Session claims.
set -euo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "$(uname -s)" != Linux ]; then
  echo 'Run this lane only on an isolated GitHub-hosted Linux runner.' >&2; exit 1
fi
payload=$(realpath "${1:?payload directory}")
evidence=$(realpath -m "${2:?evidence directory}")
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[ -f "$payload/release/MANIFEST.json" ]
mkdir -p "$evidence"
image=volli-installer-systemd:ci
box=
mode=
capture_journal() {
  local -a filters=(-u volli-runner.service)
  if [ "$mode" = user ]; then filters=("_SYSTEMD_USER_UNIT=volli-runner.service" "_UID=2000"); fi
  docker exec "$box" journalctl --no-pager -n 100 "${filters[@]}"
}
cleanup() {
  local code=$?
  trap - EXIT
  if [ -n "$box" ]; then
    docker logs "$box" >"$evidence/$mode-container.log" 2>&1 || true
    capture_journal >"$evidence/$mode-journal.log" 2>&1 || true
    docker exec "$box" journalctl --no-pager -b -n 150 >"$evidence/$mode-boot.log" 2>&1 || true
    docker rm --force "$box" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT
docker build --tag "$image" "$here"
for mode in system user; do
  box="volli-install-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-$mode"
  docker run --detach --name "$box" --privileged --cgroupns=private \
    --tmpfs /run --tmpfs /run/lock --tmpfs /tmp:exec \
    --volume "$payload/release:/release:ro" --volume "$here:/check:ro" "$image" >/dev/null
  state=
  for attempt in $(seq 1 90); do
    state=$(docker exec "$box" systemctl is-system-running 2>/dev/null || true)
    case "$state" in running|degraded) break ;; maintenance|stopping) break ;; esac
    sleep 1
  done
  case "$state" in running|degraded) ;; *) echo "systemd did not boot after $attempt checks: $state" >&2; exit 1 ;; esac
  docker exec "$box" bash /check/check-case.sh "$mode"
  # Archive/cp cannot reliably read tmpfs mounts; stream the live file instead.
  docker exec "$box" cat /tmp/install-result.json >"$evidence/$mode.json"
  docker logs "$box" >"$evidence/$mode-container.log" 2>&1 || true
  capture_journal >"$evidence/$mode-journal.log" 2>&1 || true
  docker rm --force "$box" >/dev/null
  box=
done
summary='Installer systemd lane passed for user and system: active, real status PID/socket reachable, restart, changed:false re-install, uninstall kept data/key. Runtime was an explicitly unlinked installer fixture; this is NOT online or Session proof.'
printf '%s\n' "$summary" | tee "$evidence/summary.txt"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$summary" >>"$GITHUB_STEP_SUMMARY"; fi
