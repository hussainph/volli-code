# Installer systemd contract

This small Linux CI lane tests the real built `install`, `status`, and `uninstall`
commands in fresh Ubuntu 24.04 systemd containers, for both user and system mode.
It does not require a backend or a published release.

Only `run` is replaced in the test payload by an explicitly **unlinked runtime
fixture**. It holds the real SQLite instance-lock format, exposes the local Unix
socket, writes a status readable by the real CLI, and exercises the unit's service
uid, writable config, proxy environment file, and release permissions. It never
reports online and runs no Session or model. The fixture is not part of production
runner bundles. Full runner/cloud acceptance is a separate lane.

The checks cover unit parsing (`systemd-analyze verify`), active service + matching
status PID/socket, restart to a new PID, `changed:false` on repeat install, default
uninstall retaining working data and its encryption key, and a repeat install
around the kept data. Root's `--user` is refused. Reports retain the fixture label.

After the locked dependency install and `vp run --filter @volli/runner build`, CI
runs `node apps/runner/src/install/ci/prepare.mjs <payload>` followed by
`bash apps/runner/src/install/ci/run.sh <payload> <evidence>`. The latter refuses
non-GitHub/Linux hosts; its destructive checks also require the container marker.
Evidence is JSON per mode and bounded container/unit journals, with no real
credentials. Docker runs privileged only on the disposable GitHub-hosted runner.
