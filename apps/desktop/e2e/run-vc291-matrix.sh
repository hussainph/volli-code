#!/bin/bash
# VC-291 full evidence collection: the reflow matrix (one launch per case), the
# Home surface, the forced-WebGL2 GPU-pressure row, and the a11y/copy/find
# harness — then the analyzer, which is what actually decides.
#
# This script FAILS LOUDLY. The first version ran everything with `set -x`,
# ignored every exit status, never invoked the analyzer, and printed "ALL DONE"
# unconditionally — so a row that aborted mid-run looked identical to a row that
# passed. Now: a failing probe stops the sweep, the analyzer's verdict is the
# script's verdict, and the final line says which it was.
#
#   apps/desktop/e2e/run-vc291-matrix.sh [evidenceRoot]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT" || exit 1
E2E="$ROOT/apps/desktop/e2e"
EVIDENCE="${1:-$ROOT/evidence}"
mkdir -p "$EVIDENCE"

failed=()

# Run one probe, tee its log, and remember a non-zero exit instead of losing it.
run_probe() {
  local name="$1"
  shift
  echo "=== $name ==="
  if "$@" > "$EVIDENCE/$name.log" 2>&1; then
    echo "    ok — $EVIDENCE/$name.log"
  else
    local status=$?
    echo "    FAILED (exit $status) — see $EVIDENCE/$name.log"
    tail -n 15 "$EVIDENCE/$name.log" | sed 's/^/    | /'
    failed+=("$name")
  fi
}

matrix() {
  local name="$1"
  shift
  run_probe "$name" node "$E2E/reflow-matrix-smoke.mjs" "$EVIDENCE/$name" "$@"
}

matrix matrix-control          --cases=control  --runs=3
matrix matrix-resize           --cases=resize   --runs=3
matrix matrix-focus            --cases=focus    --runs=3
matrix matrix-hsplit           --cases=hsplit   --runs=3
matrix matrix-vsplit           --cases=vsplit   --runs=3
matrix matrix-hideshow-ticket  --cases=hideshow --runs=3 --surface=ticket
matrix matrix-hideshow-home    --cases=hideshow --runs=3 --surface=home

# The GPU-pressure row. The ticket names the HOME hide/show row (Board ↔
# terminal, then terminal tab ↔ terminal tab), so it runs on the home surface,
# and 17 live terminals means the seeded pane plus 16 more.
matrix matrix-gpu-webgl2 --cases=focus,hideshow --runs=3 --webgl2 --panes-per-run=16 --surface=home

run_probe a11y node "$E2E/reflow-a11y-smoke.mjs" "$EVIDENCE/a11y"

echo
echo "=== analysis ==="
if node "$E2E/analyze-vc291.mjs" "$EVIDENCE"; then
  analysis_ok=1
else
  analysis_ok=0
  failed+=("analysis")
fi

echo
if [ ${#failed[@]} -eq 0 ] && [ "$analysis_ok" -eq 1 ]; then
  echo "VC-291 SWEEP PASSED — evidence in $EVIDENCE"
  exit 0
fi
echo "VC-291 SWEEP FAILED: ${failed[*]}"
exit 1
