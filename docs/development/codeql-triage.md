# CodeQL triage

The CodeQL workflow is not running: code scanning on a private repository
needs a GitHub Code Security licence, which a personal account cannot hold.
It was a build-less JS/TS `security-extended` analysis on PRs against main,
pushes to main and a weekly schedule; restore `.github/workflows/codeql.yml`
from history if the repository moves to an account that has the licence. The
findings already recorded, and the handling rules below, still apply.

## Read the right check

**Analyze JS/TS** reports analysis/upload success, not absence of alerts.
GitHub's separate **Code scanning results / CodeQL** check annotates findings
in the PR diff. Existing main findings do not automatically fail unrelated PRs.
See [GitHub's PR triage documentation](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/triage-alerts-in-pull-requests).

`CI gate` aggregates its own test/build/smoke jobs, not the separate CodeQL
workflow. Inspect both checks on the exact head. Neither a successful upload
nor a branch rule alone establishes that main has no unresolved findings.

## Handle findings

- Record the alert number, main commit, affected trust boundary, disposition and
  fixing change in the issue tracker. High/critical findings need an accountable
  maintainer even if no unrelated PR is red.
- Check main after scheduled analysis and security-fix merges. A fix is resolved
  on main only after it is merged and reanalyzed.
- Source relocation can change fingerprints. Check prior history before calling
  a relocated alert a newly introduced vulnerability.
- Dismiss only with a written trust-boundary explanation and evidence that the
  production exploit does not apply. A fixing branch is not a dismissal reason.
- Keep reproduction details and investigation reports in the issue/PR rather
  than committing internal audit snapshots to contributor documentation.

## Filesystem compatibility

Checking and consuming the same descriptor closes pathname check/use races.
Preserve supported manifest leaf symlinks, including dotfile-repository links;
reject FIFO/directory targets through nonblocking open and `fstat`. Blob reads
use no-follow final-component opens. Ancestor-directory ownership remains part
of the user-controlled trust boundary; do not overstate descriptor checks as
protection against every same-user writer.
