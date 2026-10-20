#!/usr/bin/env bash
# Boots the built hostd artifact against an empty data directory and drives
# it from outside, the way an operator would (README.md, "CI"), with NO
# checkout: the archive must carry everything it needs.
#
# Linux runs it in the Linux host image as its non-root user, with the
# artifact directory mounted at /out (the default):
#
#   docker run --rm -v "$PWD/.tmp/hostd:/out:ro" volli-host-dev \
#     bash -s < apps/hostd/scripts/ci-boot-artifact.sh
#
# macOS runs it directly on the runner that built the artifact, naming the
# artifact directory (release.yml, hostd-darwin):
#
#   bash apps/hostd/scripts/ci-boot-artifact.sh "$RUNNER_TEMP/hostd"
#
# Portable between GNU and BSD userlands: sha256sum or shasum, stat -c or -f.
set -euo pipefail

artifacts="${1:-${HOSTD_ARTIFACT_DIR:-/out}}"

step() { printf '\n== %s\n' "$*"; }

# Octal permission bits of a file: GNU stat on Linux, BSD stat on macOS.
mode() {
  if [[ "$(uname -s)" == Darwin ]]; then stat -f %Lp "$1"; else stat -c %a "$1"; fi
}

step "verify and unpack"
cd "$artifacts"
shopt -s nullglob
archives=(./*.tar.gz)
shopt -u nullglob
if [[ "${#archives[@]}" -ne 1 ]]; then
  echo "expected exactly one hostd archive in $artifacts, found ${#archives[@]}" >&2
  exit 1
fi
# macOS has no sha256sum; its shasum reads the same "<hex>  <name>" format.
if command -v sha256sum >/dev/null; then
  sha256sum -c "${archives[0]}.sha256"
else
  shasum -a 256 -c "${archives[0]}.sha256"
fi
unpacked=$(mktemp -d)
tar -xzf "${archives[0]}" -C "$unpacked"
root=$(echo "$unpacked"/volli-hostd-*)
cat "$root/MANIFEST.json"

# Nothing from the machine's own Node: only what the archive carries. Neither
# the image nor a macOS runner has one in /usr/bin or /bin (a runner's is in
# its tool cache, Homebrew's in /opt/homebrew or /usr/local).
export PATH=/usr/bin:/bin
if command -v node >/dev/null; then
  echo "a system node is on PATH; the artifact must not depend on one" >&2
  exit 1
fi
hostd="$root/bin/volli-hostd"
volli="$root/bin/volli"

step "natives load under the shipped Node"
"$root/bin/node" "$root/lib/probe-natives.cjs"
step "Code Mode executes from the artifact's worker and wasm"
"$root/bin/node" "$root/lib/probe-codemode.mjs"
"$hostd" --version

step "boot against an empty data directory"
# Under /tmp, not $TMPDIR: macOS's per-user TMPDIR is a long /var/folders
# path, and a unix socket path is capped at 104 bytes there.
data=$(mktemp -d /tmp/hostd-boot.XXXXXX)/data
mkdir -m 700 "$data"
log=$(mktemp)
"$hostd" --data-dir "$data" >"$log" 2>&1 &
pid=$!
serving=false
for _ in $(seq 1 150); do
  if "$hostd" status --data-dir "$data" >/dev/null 2>&1; then
    serving=true
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 0.2
done
"$hostd" status --data-dir "$data" || true
if [[ "$serving" != true ]]; then
  echo "volli-hostd did not reach serving" >&2
  cat "$log" >&2
  exit 1
fi
test "$(mode "$data/volli.sock")" = 600

step "the volli CLI lists projects through the socket"
projects=$(env -u VOLLI_SESSION -u VOLLI_SESSION_TOKEN -u VOLLI_TICKET \
  VOLLI_SOCKET="$data/volli.sock" "$volli" project list --json)
echo "$projects"
"$root/bin/node" -e '
  const answer = JSON.parse(process.argv[1]);
  if (!Array.isArray(answer.projects) || answer.projects.length !== 0) {
    throw new Error("expected an empty project list from an empty data directory");
  }' "$projects"

step "SIGTERM exits cleanly"
kill -TERM "$pid"
code=0
wait "$pid" || code=$?
cat "$log"
if [[ "$code" -ne 0 ]]; then
  echo "volli-hostd exited $code after SIGTERM" >&2
  exit 1
fi
status_code=0
"$hostd" status --data-dir "$data" >/dev/null || status_code=$?
test "$status_code" -eq 3
test ! -e "$data/volli.sock"
test ! -e "$data/volli.db-wal"

step "the database is whole"
cd "$root/lib"
"$root/bin/node" -e '
  const Database = require("better-sqlite3");
  const db = new Database(process.argv[1], { readonly: true });
  const result = db.pragma("integrity_check", { simple: true });
  console.log(`integrity_check: ${result}, user_version: ${db.pragma("user_version", { simple: true })}`);
  if (result !== "ok") process.exit(1);' "$data/volli.db"

step "every log line is one JSON object"
"$root/bin/node" -e '
  const lines = require("node:fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
  for (const line of lines) {
    const entry = JSON.parse(line);
    for (const key of ["ts", "level", "msg"]) if (!(key in entry)) throw new Error(`no ${key}: ${line}`);
  }
  const messages = lines.map((line) => JSON.parse(line).msg);
  for (const expected of ["starting", "serving", "stopping", "stopped"]) {
    if (!messages.includes(expected)) throw new Error(`no "${expected}" line`);
  }
  console.log(`${lines.length} JSON log lines`);' "$log"

echo
echo "hostd artifact boots, serves the CLI and stops cleanly."
