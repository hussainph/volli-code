#!/usr/bin/env bash
# Builds the hostd artifact inside the Linux host image (CI's "Build (host
# container)" job; README.md, "CI"). The checkout is mounted read-only at
# /src and the artifact is written to /out. Run it locally the same way:
#
#   docker build -f .devcontainer/host/Dockerfile -t volli-host-dev .
#   docker run --rm -v "$PWD:/src:ro" -v "$PWD/.tmp/hostd:/out" volli-host-dev \
#     bash /src/apps/hostd/scripts/ci-build-artifact.sh
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

node apps/hostd/scripts/package.mjs --out /out
