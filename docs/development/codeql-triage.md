# CodeQL triage

## PR checks are not a backlog gate

`.github/workflows/codeql.yml` runs build-less JS/TS `security-extended` analysis
on PRs against main, pushes to main, and Mondays at 04:00 UTC. `Analyze JS/TS`
reports whether analysis/upload succeeded, not whether main has zero alerts.
GitHub's separate **Code scanning results / CodeQL** check annotates new alerts
in the PR diff; existing main alerts do not automatically fail unrelated PRs.
High/critical security findings and error-level findings fail that results check
by default. See [GitHub's PR triage documentation](https://docs.github.com/en/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/triage-alerts-in-pull-requests).

The `CI gate` job in `ci.yml` aggregates its own test/build/smoke jobs, not the
separate CodeQL workflow. At the VC-694 inspection, the repository's active
`Main Protection` ruleset contained only deletion/non-fast-forward protection;
there was no required-status-check or required-code-scanning rule. Thus neither
a green analysis job nor the current ruleset is evidence of a clean backlog.
This ticket does not change branch protection or replace diff-scoped PR checks.

## Backlog ownership

The repository maintainer (`@hussainph`) is the accountable backlog owner. Route
host-core findings to a `security`-labelled Volli ticket, with the alert number,
main commit, affected trust boundary, disposition, and fixing PR. VC-694 owns the
seven high findings below until main is reanalyzed after merge. Check main's
open alerts after the weekly analysis as well as after security-fix merges;
new high/critical findings need an explicit owner and ticket, even if no PR is
red. Do not treat an alert's relocation as a new vulnerability without checking
its earlier history.

A fix remains open on main until merged and reanalyzed. Dismiss only with a
written explanation of the trust boundary and why no production exploit is
possible; do not dismiss a still-vulnerable main instance just because a fixing
branch exists.

## VC-694 baseline

The main analysis inspected on 2026-10-06 was at
`9bfe50744263f862b8826a2b95cdd776518e04ab`: ten total results, seven open high
alerts. The seven high alerts were created on 2026-10-04. Source relocation
around the host-core extraction is a plausible reason for renewed fingerprints,
not proof of a newly introduced defect.

| Alert | Rule / file | Disposition |
| --- | --- | --- |
| 58, 59 | ReDoS / `agent-tools.ts` | Fix both trailing-slash regexes with a backwards character scan; adversarial long slash-run timing and compatibility tests. |
| 55 | Git argument injection / `worktree/git.ts` | Admit only the local command/option vocabulary used by production callers, reject option-prefixed refs and worktree operands, and add command-appropriate `--` / `--end-of-options` boundaries. Literal option-looking filenames remain valid only behind `ls-files --`. Real-git compatibility and malicious-input tests cover both runners. |
| 56 | Filesystem race / `blob-store.ts` | Validate existing blobs with no-follow descriptors; write a new exclusive descriptor and atomically hard-link complete bytes without replacing an existing destination. Reads validate and consume the same descriptor. |
| 57 | Filesystem race / `worktree/change-set.ts` | Inspect and read one no-follow descriptor for untracked file previews, closing it on every exit. |
| 61 | Filesystem race / `harness-registry.ts` | Inspect and read a manifest through one no-follow descriptor. |
| 60 | Filesystem race / `agent-tools.test.ts` | Dismiss as **used in tests**: the uninstall regression creates a private `mkdtemp` fixture, asserts a skill exists, invokes uninstall, then expects `readFile` to fail with ENOENT. The intervening deletion is intentional; there is no production check/use operation or attacker-controlled input. No code change is needed. |

## Decisions to confirm

- Keep diff-scoped PR results; consider requiring both `CI gate` and the CodeQL
  results check in main's ruleset separately. Enforcement is a maintainer decision,
  not an implicit part of this remediation.
- Manifest leaf symlinks (including legitimate dotfile-repository links) are now
  refused rather than followed. This is the explicit no-follow security stance;
  users must place a regular manifest at the registered location. No-follow opens
  protect the final component, not hostile ancestor-directory replacements. The
  registry/blob parent directories remain a user-owned trust boundary.
