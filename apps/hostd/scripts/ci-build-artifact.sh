#!/usr/bin/env bash
# Builds the hostd artifact inside the Linux host image (CI's "Build (host
# container)" job; README.md, "CI"). The checkout is mounted read-only at
# /src and the artifact is written to /out. Run it locally the same way:
#
#   docker build -f .devcontainer/host/Dockerfile -t volli-host-dev .
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/.tmp/hostd:/out" volli-host-dev \
#     bash /src/apps/hostd/scripts/ci-build-artifact.sh
#
# macOS has no image: release.yml's hostd-darwin job runs the same install,
# integration test and packager directly on the runner, and
# scripts/release-workflow.test.mjs holds the two in step.
set -euo pipefail

repo=/workspace/repo
mkdir -p "$repo"
# The working tree without anyone's node_modules: natives here are built for
# this image's Node and glibc, never copied from the host machine.
tar -C /src --exclude='./.git/modules' --exclude='node_modules' --exclude='./.tmp' -cf - . \
  | tar -C "$repo" -xf -
cd "$repo"

# The host-only install docs/development/host-linux.md describes: root
# tooling, every package and hostd, never desktop (no Electron rebuild).
pnpm --filter volli-code --filter './packages/*' --filter './apps/hostd' \
  install --frozen-lockfile

# VC-622: real hostd/Pi/SQLite/socket; only the provider wire is scripted.
# Session birth must go through the built CLI, then a real tool and turn.completed.
pnpm --filter @volli/hostd exec vp test run src/session-runtime.integration.test.ts \
  --maxWorkers="${VOLLI_CONCURRENCY_HINT:-2}"

node apps/hostd/scripts/package.mjs --out /out
