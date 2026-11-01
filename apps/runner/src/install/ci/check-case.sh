#!/bin/bash
# Runs only inside the disposable systemd container, never on the developer's host.
set -euo pipefail
if [ ! -f /.dockerenv ] || [ "${VOLLI_INSTALLER_CI_BOX:-}" != 1 ]; then echo "Refusing to run outside the installer CI container" >&2; exit 1; fi
mode=${1:?system or user}
source_cli=/release/bin/volli-runner
node=/release/bin/node
unit=volli-runner.service
update_path=volli-runner-update.path
update_service=volli-runner-update.service
proxy=http://fixture-user:fixture-password%20@127.0.0.1:9
if [ "$(cat /proc/1/comm)" != systemd ]; then echo 'PID1 is not systemd' >&2; exit 1; fi
if "$source_cli" install --user --from /release --no-start --no-link >/tmp/root-user-refusal 2>&1; then
  echo 'install --user unexpectedly accepted root' >&2; exit 1
fi
if [ "$mode" = system ]; then
  owner=volli
  root=/opt/volli-runner
  data=/var/lib/volli-runner
  config=/etc/volli-runner
  unit_file=/etc/systemd/system/$unit
  cli=/usr/local/bin/volli-runner
  invoke() { env HTTPS_PROXY="$proxy" "$@"; }
  ctl() { systemctl "$@"; }
  verify() { systemd-analyze verify "$unit_file" "$update_path_file" "$update_service_file"; }
elif [ "$mode" = user ]; then
  owner=installer-user
  useradd --create-home --user-group --shell /bin/bash --uid 2000 "$owner"
  loginctl enable-linger "$owner"
  systemctl start user@2000.service
  root=/home/$owner/.local/share/volli-runner
  data=/home/$owner/.local/state/volli-runner
  config=/home/$owner/.config/volli-runner
  unit_file=/home/$owner/.config/systemd/user/$unit
  cli=/home/$owner/.local/bin/volli-runner
  invoke() { runuser -u "$owner" -- env HOME="/home/$owner" XDG_RUNTIME_DIR=/run/user/2000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/2000/bus HTTPS_PROXY="$proxy" "$@"; }
  ctl() { invoke systemctl --user "$@"; }
  verify() { invoke systemd-analyze --user verify "$unit_file" "$update_path_file" "$update_service_file"; }
else
  echo 'unknown mode' >&2; exit 2
fi

update_path_file=${unit_file%/*}/$update_path
update_service_file=${unit_file%/*}/$update_service
invoke "$source_cli" install "--$mode" --from /release --no-start --no-link >/tmp/first-install
verify
for name in "$unit" "$update_path" "$update_service"; do ctl is-enabled --quiet "$name"; done
ctl enable --now "$unit" "$update_path"
ctl is-active --quiet "$update_path"

# Status must be the actual CLI reading a live pid and accepting Unix socket,
# not merely a file the fixture wrote. Exit 3 is the explicit unlinked contract.
wait_status() {
  local expected_old_pid=${1:-0}
  local attempt code pid
  for attempt in $(seq 1 60); do
    pid=$(ctl show -p MainPID --value "$unit")
    if invoke "$cli" status --data-dir "$data" --config-dir "$config" >/tmp/current-status.json; then code=0; else code=$?; fi
    if ctl is-active --quiet "$unit" && [ "$code" = 3 ] && [ "$pid" != 0 ] && [ "$pid" != "$expected_old_pid" ]; then
      if "$node" -e '
        const fs = require("node:fs");
        const s = JSON.parse(fs.readFileSync("/tmp/current-status.json", "utf8"));
        const [pid, mode, root] = process.argv.slice(1);
        const f = s.status?.fixture;
        if (s.verdict !== "not-serving" || s.detail !== "unlinked" || s.status?.pid !== Number(pid) || f?.runtime !== "installer-only-unlinked" || f.uid === 0 || !f.service || f.installMode !== mode || !f.releaseRoot.startsWith(root + "/releases/") || !f.proxyConfigured || f.canWriteRelease !== (mode === "user")) process.exit(1);
      ' "$pid" "$mode" "$root"; then return 0; fi
    fi
    sleep 1
  done
  echo "status did not match the live unit after $attempt checks" >&2
  ctl status "$unit" --no-pager || true
  exit 1
}
wait_status
# The enabled oneshot must also execute the real updater's no-request path.
# This proves unit wiring only, not an update, rollback, or online acceptance.
ctl start "$update_service"
[ "$(ctl show -p ExecMainStatus --value "$update_service")" = 0 ]
first_pid=$(ctl show -p MainPID --value "$unit")
ctl restart "$unit"
wait_status "$first_pid"
second_pid=$(ctl show -p MainPID --value "$unit")

invoke "$source_cli" install "--$mode" --from /release --no-start --no-link >/tmp/second-install
"$node" -e 'const fs=require("node:fs"); const first=fs.readFileSync("/tmp/second-install","utf8").split("\n")[0]; if(JSON.parse(first).changed !== false) process.exit(1)'
for name in "$unit" "$update_service"; do
  if ctl show -p Environment --value "$name" | /bin/grep -q fixture-password; then
    echo "Proxy credential exposed through Environment property: $name" >&2; exit 1
  fi
done
[ "$(stat -c %a "$root/proxy.env")" = 600 ]
[ -f "$config/installer-config-probe" ]
runuser -u "$owner" -- sh -c 'printf "uncommitted work\n" > "$1/preserved.txt"' sh "$data"
key_before=$(sha256sum "$config/session-secrets.key" | cut -d ' ' -f 1)
invoke "$cli" uninstall "--$mode" --keep-data >/tmp/uninstall
[ -f "$data/preserved.txt" ]
[ "$(sha256sum "$config/session-secrets.key" | cut -d ' ' -f 1)" = "$key_before" ]
[ ! -e "$root" ]
[ ! -e "$cli" ]
[ ! -e "$unit_file" ]
[ ! -e "$update_path_file" ]
[ ! -e "$update_service_file" ]
for name in "$unit" "$update_path" "$update_service"; do
  if ctl is-active --quiet "$name"; then echo "unit still active after uninstall: $name" >&2; exit 1; fi
  if ctl is-enabled --quiet "$name"; then echo "unit still enabled after uninstall: $name" >&2; exit 1; fi
done
# Recreate the removed code/unit around the kept data, then prove the next
# install is idempotent without replacing the retained encryption key.
invoke "$source_cli" install "--$mode" --from /release --no-start --no-link >/tmp/reinstall
invoke "$source_cli" install "--$mode" --from /release --no-start --no-link >/tmp/idempotent-reinstall
"$node" -e 'const fs=require("node:fs"); const first=fs.readFileSync("/tmp/idempotent-reinstall","utf8").split("\n")[0]; if(JSON.parse(first).changed !== false) process.exit(1)'
[ "$(sha256sum "$config/session-secrets.key" | cut -d ' ' -f 1)" = "$key_before" ]
invoke "$cli" uninstall "--$mode" --keep-data >/tmp/final-uninstall
[ -f "$data/preserved.txt" ]
[ ! -e "$root" ]
[ ! -e "$unit_file" ]
[ ! -e "$update_path_file" ]
[ ! -e "$update_service_file" ]
"$node" -e 'const fs=require("node:fs"); const [mode,firstPid,secondPid]=process.argv.slice(1); fs.writeFileSync("/tmp/install-result.json",JSON.stringify({mode,runtime:"installer-only-unlinked-fixture",unitActive:true,statusReachable:true,firstPid:Number(firstPid),secondPid:Number(secondPid),restarted:true,idempotentChanged:false,reinstalledWithKeptData:true,keptData:true,keptEncryptionKey:true,unitRemoved:true,updateUnitsEnabled:true,updateWatcherActive:true,idleUpdateApply:true,updateUnitsRemoved:true})+"\n")' "$mode" "$first_pid" "$second_pid"
echo "PASS $mode: active + status reachable (unlinked fixture), restart, changed:false, uninstall kept data/key"
