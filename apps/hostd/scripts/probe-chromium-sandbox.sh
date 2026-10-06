#!/usr/bin/env bash
# Can Chromium start sandboxed under volli-hostd.service's hardening? (VC-619)
#
# Starts Chromium once, with its sandbox (never --no-sandbox), as a transient
# systemd service carrying every directive in the unit's hardening block — read
# from packaging/volli-hostd.service itself, so this tests the unit as shipped,
# not a copy of it. Exits 0 only when a renderer runs in its own user
# namespace under a seccomp filter: the sandbox, engaged.
#
#   sudo apps/hostd/scripts/probe-chromium-sandbox.sh /opt/volli-chromium/chrome [user]
#   sudo /opt/volli-hostd/share/probe-chromium-sandbox.sh /opt/volli-chromium/chrome volli
#
# The binary must sit outside /home (the unit's ProtectHome= hides it), and on
# Ubuntu 23.10+ needs packaging/volli-chromium.apparmor loaded for its path.
# CI's "Test (packages)" lane runs this; so can an operator on the box.
set -euo pipefail

chrome="${1:?usage: probe-chromium-sandbox.sh <chromium binary> [user]}"
user="${2:-${SUDO_USER:-$(id -un)}}"
here="$(cd "$(dirname "$0")" && pwd)"
# The source tree's unit, or the artifact's (share/systemd beside share/ this script).
unit="$here/../packaging/volli-hostd.service"
[[ -f $unit ]] || unit="$here/systemd/volli-hostd.service"

properties=()
hardening=0
while IFS= read -r line; do
  case "$line" in
    "# Hardening"*) hardening=1; continue ;;
    "["*) hardening=0 ;;
  esac
  if [[ $hardening == 1 && $line =~ ^[A-Za-z]+= ]]; then
    properties+=(-p "$line")
  fi
done <"$unit"
if ((${#properties[@]} == 0)); then
  echo "probe: no hardening directives found in $unit" >&2
  exit 1
fi
printf 'probe: %s\n' "${properties[*]}"

# What runs inside the unit: Chromium on a blank page, then a look at its
# renderer from outside. Sandboxed means the renderer sits in a user namespace
# of its own (the namespace sandbox) and under a seccomp-BPF filter. Chromium
# without a usable sandbox aborts at launch instead ("No usable sandbox!").
inner='
chrome="$1"
"$chrome" --headless --no-first-run --disable-background-networking \
  --user-data-dir=/tmp/volli-chromium-probe about:blank 2>/tmp/volli-chromium-probe.log &
browser=$!
verdict=""
for _ in $(seq 1 40); do
  sleep 0.5
  if ! kill -0 "$browser" 2>/dev/null; then verdict="exited"; break; fi
  for pid in $(pgrep -f -- "--type=renderer" || true); do
    [ "$(readlink "/proc/$pid/ns/user")" != "$(readlink "/proc/$browser/ns/user")" ] || continue
    seccomp=$(awk "/^Seccomp:/ {print \$2}" "/proc/$pid/status")
    [ "$seccomp" = 2 ] || continue
    verdict="sandboxed renderer $pid: own user namespace, seccomp filter"
    break 2
  done
done
kill "$browser" 2>/dev/null; wait "$browser" 2>/dev/null
case "$verdict" in
  sandboxed*) echo "$verdict" ;;
  *) echo "verdict: ${verdict:-no sandboxed renderer within 20 s}"; tail -20 /tmp/volli-chromium-probe.log; exit 1 ;;
esac
'

status=0
output="$(
  systemd-run --quiet --wait --pipe --collect -p RuntimeMaxSec=60 \
    -p User="$user" -p Environment=HOME=/tmp "${properties[@]}" -- \
    /bin/bash -c "$inner" probe "$chrome" 2>&1
)" || status=$?
printf '%s\n' "$output" | tail -25
if ((status != 0)); then
  echo "probe: Chromium did not run sandboxed under the unit's hardening (exit $status)" >&2
  exit 1
fi
echo "probe: Chromium is sandboxed under volli-hostd.service's hardening"
