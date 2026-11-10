#!/usr/bin/env bash
# Native build, inside the bullseye image. /src is a read-only checkout;
# never copy the developer's native node_modules into this ABI baseline.
set -euo pipefail
repo=/workspace/repo
mkdir -p "$repo"
tar -C /src --exclude='./.git/modules' --exclude='node_modules' \
  --exclude='./.tmp' --exclude='./.scratch' -cf - . | tar -C "$repo" -xf -
cd "$repo"
pnpm --filter volli-code --filter './packages/*' --filter './apps/runner' \
  install --frozen-lockfile
shellcheck -s sh apps/runner/packaging/install.sh
shellcheck apps/runner/scripts/ci-build-artifact.sh apps/runner/scripts/ci-boot-artifact.sh apps/runner/scripts/ci-install-matrix.sh
node apps/runner/scripts/package.mjs --out /out
