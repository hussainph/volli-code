#!/bin/bash
# VC-291 full evidence collection: reflow matrix (per-case launches), Home
# surface, forced-WebGL2 GPU-pressure row, and the a11y/copy/find harness.
# Every run writes its own evidence/<name>/ tree (matrix.json, screenshots +
# OCR sidecars, reference-file copies, run-config).
set -x
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT" || exit 1
mkdir -p evidence
E2E="$ROOT/apps/desktop/e2e"

node $E2E/reflow-matrix-smoke.mjs evidence/matrix-control        --cases=control  --runs=3 > evidence/matrix-control.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-resize         --cases=resize   --runs=3 > evidence/matrix-resize.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-focus          --cases=focus    --runs=3 > evidence/matrix-focus.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-hsplit         --cases=hsplit   --runs=3 > evidence/matrix-hsplit.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-vsplit         --cases=vsplit   --runs=3 > evidence/matrix-vsplit.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-hideshow-ticket --cases=hideshow --runs=3 --surface=ticket > evidence/matrix-hideshow-ticket.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-hideshow-home  --cases=hideshow --runs=3 --surface=home > evidence/matrix-hideshow-home.log 2>&1
node $E2E/reflow-matrix-smoke.mjs evidence/matrix-gpu-webgl2     --cases=focus,hideshow --runs=3 --webgl2 --panes-per-run=16 --surface=ticket > evidence/matrix-gpu-webgl2.log 2>&1
node $E2E/reflow-a11y-smoke.mjs evidence/a11y > evidence/a11y.log 2>&1
echo "ALL DONE"
