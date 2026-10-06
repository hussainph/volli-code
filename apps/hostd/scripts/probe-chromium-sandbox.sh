#!/usr/bin/env bash
# Can Chromium start sandboxed under volli-hostd.service's hardening? (VC-619)
#
# Starts Chromium once, with its sandbox (never --no-sandbox), as a transient
# systemd service carrying every directive in the unit's hardening block — read
# from packaging/volli-hostd.service itself, so this tests the unit as shipped,
# not a copy of it. Exits 0 only when Chromium reports itself sandboxed.
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

status=0
output="$(
  systemd-run --quiet --wait --pipe --collect \
    -p User="$user" -p Environment=HOME=/tmp "${properties[@]}" -- \
    "$chrome" --headless --no-first-run --user-data-dir=/tmp/volli-chromium-probe \
    --dump-dom chrome://sandbox 2>&1
)" || status=$?
if ((status != 0)); then
  printf '%s\n' "$output" | tail -40 >&2
  echo "probe: Chromium did not start sandboxed under the unit's hardening (exit $status)" >&2
  exit 1
fi
if ! grep -q "adequately sandboxed" <<<"$output"; then
  printf '%s\n' "$output" | tail -40 >&2
  echo "probe: Chromium started, but chrome://sandbox does not report it sandboxed" >&2
  exit 1
fi
echo "probe: Chromium is sandboxed under volli-hostd.service's hardening"
