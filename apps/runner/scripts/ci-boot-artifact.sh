#!/usr/bin/env bash
# Run inside the build image, with only the artifact mounted at /out (no source).
set -euo pipefail
artifacts="${1:-/out}"
cd "$artifacts"
shopt -s nullglob
archives=(./volli-runner-*.tar.gz)
[[ ${#archives[@]} -eq 1 ]] || { echo 'expected one runner archive' >&2; exit 1; }
sha256sum -c "${archives[0]}.sha256"
unpacked=$(mktemp -d)
data=$(mktemp -d)
log=$(mktemp)
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi
  rm -rf "$unpacked" "$data" "$log"
}
trap cleanup EXIT
tar -xzf "${archives[0]}" -C "$unpacked"
root=$(echo "$unpacked"/volli-runner-*)
# Deliberately hide the image's /usr/local/bin/node and pnpm.
export PATH=/usr/bin:/bin
! command -v node >/dev/null || { echo 'system Node unexpectedly available' >&2; exit 1; }
"$root/bin/node" "$root/lib/probe-natives.cjs"
"$root/bin/node" "$root/lib/probe-codemode.mjs"
expected_version=$("$root/bin/node" -e 'console.log(require(process.argv[1]).version)' "$root/MANIFEST.json")
test "$("$root/bin/volli-runner" version)" = "$expected_version"
status_code=0
"$root/bin/volli-runner" status --data-dir "$data" || status_code=$?
test "$status_code" -eq 3
# The initial command-registry release intentionally ships a run stub. Prove
# that exact boundary, not a generic exit69. Richer builds must pass the real
# unlinked lifecycle below; a crash is never accepted as a skeleton.
help_code=0
"$root/bin/volli-runner" run --help >"$log" 2>&1 || help_code=$?
if [[ "$help_code" -eq 69 ]] && grep -Fq 'volli-runner: `run` is not available in this build yet.' "$log"; then
  cat "$log"
  echo 'Runner skeleton artifact: natives, Code Mode, version and unlinked status passed; run is explicitly unavailable.'
  exit 0
fi
test "$help_code" -eq 0
"$root/bin/volli-runner" run --data-dir "$data" >"$log" 2>&1 &
pid=$!
# An unlinked daemon must stay up for linking, not exit successfully as a stub.
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || { cat "$log" >&2; exit 1; }
  sleep 0.2
done
kill -TERM "$pid"
code=0
wait "$pid" || code=$?
pid=
cat "$log"
test "$code" -eq 0
echo 'Runner artifact probes, unlinked boot and SIGTERM passed.'
