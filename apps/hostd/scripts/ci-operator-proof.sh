#!/usr/bin/env bash
# VC-623's proof on a real Linux box: the operator token separates the person
# from the service account. Runs AS ROOT in a fresh host image with the built
# artifact at /out and no checkout, laid out the way README.md's systemd
# section installs it:
#
#   docker run --rm -i --user 0 -v "$PWD/.tmp/hostd:/out:ro" volli-host-dev \
#     bash -s < apps/hostd/scripts/ci-operator-proof.sh
#
# It shows, in order: root issues a token for a non-service login; that login
# registers a project and creates a ticket with the bundled `volli` CLI; a
# token-less caller and a Session-token caller are refused; the `volli`
# service account can neither read the token nor mint one; revocation holds
# from the next request.
set -euo pipefail

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
test "$(id -u)" -eq 0 || fail "run this as root"

step "install the artifact root-owned, as the README does"
cd /out
sha256sum -c ./*.tar.gz.sha256
mkdir -p /opt/volli-hostd
tar -xzf ./*.tar.gz -C /opt/volli-hostd --strip-components=1 --no-same-owner
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
hostd=/opt/volli-hostd/bin/volli-hostd
volli=/opt/volli-hostd/bin/volli

step "a service account, and an operator in its group"
useradd --system --create-home --home-dir /var/lib/volli-hostd --shell /bin/bash volli
chmod 700 /var/lib/volli-hostd
useradd --create-home --shell /bin/bash ops
usermod -aG volli ops
# What systemd's RuntimeDirectory=volli-hostd with RuntimeDirectoryMode=0750 makes.
install -d -o volli -g volli -m 750 /run/volli-hostd
socket=/run/volli-hostd/volli.sock
install -d -o ops -g ops -m 755 /srv/demo
runuser -u ops -- git -C /srv/demo init --quiet --initial-branch=main

step "root issues ops a token"
"$hostd" operator-token --for ops
token_file=/home/ops/.config/volli/operator-token
test "$(stat -c '%U %a' "$token_file")" = "ops 600" || fail "token file is not ops' 0600"
test "$(stat -c '%U %a' "$(dirname "$token_file")")" = "ops 700" || fail "token dir is not ops' 0700"
test "$(stat -c '%U %G %a' /etc/volli-hostd-operators)" = "root volli 640" ||
  fail "operators file is not root:volli 0640"
token=$(cat "$token_file")
grep -q '^ops [0-9]* sha256:[0-9a-f]\{64\} ' /etc/volli-hostd-operators || fail "no verifier for ops"
if grep -qF "$token" /etc/volli-hostd-operators; then fail "the operators file holds the plaintext"; fi
echo "verifier recorded; the plaintext is only in $token_file"

step "root will not issue one to the service account"
code=0
"$hostd" operator-token --for volli 2>&1 || code=$?
test "$code" -eq 1 || fail "issuing to the service account exited $code"

step "hostd runs as the service account, socket 0660 in a 0750 directory"
log=$(mktemp)
chmod 644 "$log"
# setpriv execs in place, so $! is hostd itself and SIGTERM reaches it as
# systemd's would (runuser would stay the parent and exit 143).
setpriv --reuid=volli --regid=volli --init-groups -- "$hostd" --data-dir /var/lib/volli-hostd \
  --socket "$socket" --socket-mode 660 >"$log" 2>&1 &
pid=$!
serving=false
for _ in $(seq 1 150); do
  if runuser -u volli -- "$hostd" status --data-dir /var/lib/volli-hostd >/dev/null 2>&1; then
    serving=true
    break
  fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
if [[ "$serving" != true ]]; then
  cat "$log" >&2
  fail "volli-hostd did not reach serving"
fi
test "$(stat -c '%U %G %a' "$socket")" = "volli volli 660" || fail "socket is not volli:volli 0660"

# One CLI call as `who`, with a clean environment: no Volli Session variables
# unless the caller passes them.
as() {
  local who=$1 home=$2
  shift 2
  runuser -u "$who" -- env -i PATH=/usr/bin:/bin HOME="$home" VOLLI_SOCKET="$socket" "$@"
}
expect_refused() {
  local label=$1 out
  shift
  if out=$("$@" 2>&1); then fail "$label was not refused: $out"; fi
  grep -q FORBIDDEN_ACTOR <<<"$out" || fail "$label failed, but not as FORBIDDEN_ACTOR: $out"
  echo "refused as expected: $label"
}

step "ops registers a project and creates a ticket over the socket"
added=$(as ops /home/ops "$volli" project add /srv/demo --json)
echo "$added"
grep -q '"created": *true' <<<"$added" || fail "project add did not create"
prefix=$(/opt/volli-hostd/bin/node -e 'process.stdout.write(JSON.parse(process.argv[1]).project.prefix)' "$added")
as ops /home/ops "$volli" ticket create --title "Created over SSH" --project "$prefix"
as ops /home/ops "$volli" ticket list --project "$prefix" | grep -q "Created over SSH" ||
  fail "the ticket is not on the board"
as ops /home/ops "$volli" ticket events "$prefix-1" --json | grep -q '"actor": *"user"' ||
  fail "the ticket was not attributed to the person"

step "a token-less caller and a Session-token caller are refused as before"
install -d -o ops -g ops -m 700 /tmp/ops-empty-home
expect_refused "ops without a token" \
  as ops /tmp/ops-empty-home "$volli" ticket create --title "No token" --project "$prefix"
expect_refused "a Session token beside ops' token file" \
  as ops /home/ops VOLLI_SESSION=abcdef12-3456-7890-abcd-ef1234567890 \
  VOLLI_SESSION_TOKEN=minted-elsewhere "$volli" ticket create --title "Session" --project "$prefix"
expect_refused "project add with a Session token" \
  as ops /home/ops VOLLI_SESSION_TOKEN=minted-elsewhere "$volli" project add /srv/demo

step "the service account cannot read the token or mint one"
if runuser -u volli -- cat "$token_file" >/dev/null 2>&1; then fail "volli read ops' token"; fi
echo "volli cannot read $token_file"
code=0
runuser -u volli -- "$hostd" operator-token --for volli 2>&1 || code=$?
test "$code" -eq 77 || fail "volli ran operator-token (exit $code)"
code=0
runuser -u volli -- "$hostd" operator-token --for ops 2>&1 || code=$?
test "$code" -eq 77 || fail "volli ran operator-token for ops (exit $code)"
if runuser -u volli -- sh -c 'echo "volli 999 sha256:00 now" >> /etc/volli-hostd-operators' 2>/dev/null; then
  fail "volli wrote the operators file"
fi
echo "volli cannot write /etc/volli-hostd-operators"
expect_refused "volli presenting a token of its own making" \
  as volli /var/lib/volli-hostd VOLLI_OPERATOR_TOKEN=volli_op_forged "$volli" project add /srv/demo

step "revocation holds from the next request, with no restart"
"$hostd" operator-token --revoke ops
expect_refused "ops after revocation" \
  as ops /home/ops "$volli" ticket create --title "Revoked" --project "$prefix"

step "stop, and read the audit"
kill -TERM "$pid"
code=0
wait "$pid" || code=$?
test "$code" -eq 0 || fail "volli-hostd exited $code after SIGTERM"
grep '"msg":"operator write"' "$log"
grep '"msg":"operator write"' "$log" | grep '"login":"ops"' | grep -q '"cmd":"project.add"' ||
  fail "no audit line for ops' project add"
if grep -qF "$token" "$log"; then fail "the log carries the token"; fi

echo
echo "operator token: issued by root, used by ops, refused to everyone else, revocable."
