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
install_home=$(mktemp -d)
log=$(mktemp)
pid=
cleanup() {
  if [[ -n "$pid" ]]; then kill -TERM "$pid" 2>/dev/null || true; wait "$pid" || true; fi
  rm -rf "$unpacked" "$data" "$install_home" "$log"
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
# A published runner must provide the binary installer too, even if its run
# command landed first. Dry runs can prove the skeleton's packaging separately.
if [[ "${ALLOW_SKELETON:-false}" != true ]]; then
  # Help succeeds even for command-registry stubs. Exercise the real installer
  # in a disposable home, without linking or starting a service.
  env HOME="$install_home" XDG_DATA_HOME="$install_home/.local/share" \
    XDG_STATE_HOME="$install_home/.local/state" XDG_CONFIG_HOME="$install_home/.config" \
    "$root/bin/volli-runner" install --user --from "$root" --no-start --no-link >"$log" 2>&1 || {
    cat "$log"
    echo 'Cannot publish an unfinished runner: install failed.' >&2
    exit 1
  }
  current="$install_home/.local/share/volli-runner/current"
  installed="$install_home/.local/bin/volli-runner"
  [[ -L "$current" && -x "$installed" ]] || { echo 'Installed runner layout is incomplete.' >&2; exit 1; }
  [[ "$(readlink -f "$current")" = "$install_home/.local/share/volli-runner/releases/"* ]] || {
    echo 'Installed current link escapes the release prefix.' >&2; exit 1;
  }
  test "$(env HOME="$install_home" "$installed" version)" = "$expected_version"
fi
# Execute run itself: --help is implemented even while run is still a stub.
"$root/bin/volli-runner" run --data-dir "$data" >"$log" 2>&1 &
pid=$!
for _ in $(seq 1 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    code=0
    wait "$pid" || code=$?
    pid=
    cat "$log"
    if [[ "$code" -eq 69 ]] && grep -Fxq "volli-runner: \`run\` is not available in this build yet." "$log"; then
      [[ "${ALLOW_SKELETON:-false}" = true ]] || { echo 'Cannot publish an unfinished runner: run is still a stub.' >&2; exit 1; }
      echo 'Runner skeleton artifact: natives, Code Mode, version and unlinked status passed; run is explicitly unavailable.'
      exit 0
    fi
    echo "Runner exited before serving (code $code)." >&2
    exit 1
  fi
  sleep 0.2
done
kill -TERM "$pid"
code=0
wait "$pid" || code=$?
pid=
cat "$log"
test "$code" -eq 0
echo 'Runner artifact probes, unlinked boot and SIGTERM passed.'
