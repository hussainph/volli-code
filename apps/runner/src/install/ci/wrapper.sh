#!/bin/sh
# Installer-test payload only: run uses an explicitly unlinked runtime fixture.
set -eu
SELF=$0
while [ -L "$SELF" ]; do
  DIR=$(CDPATH= cd -P -- "$(dirname -- "$SELF")" && pwd)
  TARGET=$(readlink "$SELF")
  case "$TARGET" in
    /*) SELF=$TARGET ;;
    *) SELF=$DIR/$TARGET ;;
  esac
done
HERE=$(CDPATH= cd -P -- "$(dirname -- "$SELF")" && pwd)
if [ "${1-}" = run ]; then
  exec "$HERE/node" "$HERE/../lib/install-runtime-fixture.mjs" "$@"
fi
exec "$HERE/node" "$HERE/../lib/runner/runner.cjs" "$@"
