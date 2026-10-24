# Contributing to Volli

Volli is a local-first macOS workspace for Tickets, Sessions, worktrees, and review. This guide covers the workflow used for changes to the app.

## Prerequisites

Use macOS, Node.js `^24.16.0`, and pnpm `11.10.0`. A `.nvmrc` carries the pin (`nvm use`), and the range is enforced rather than advisory: `pnpm install` hard-fails outside it (`engineStrict` in `pnpm-workspace.yaml`), and the desktop dev/start scripts preflight the running Node before anything spawns — an unsupported Node builds native modules (better-sqlite3, node-pty) against the wrong ABI, which surfaces later as a dead database and a greyed-out sign-in. Install dependencies from the repository root:

```bash
pnpm install
```

Validation uses the repository's `vite-plus` CLI (`vp`). Use `pnpm exec vp` if
`vp` is not already on your PATH.

## Workflow

Start from an up-to-date `main` branch and make your change on a branch. Ticket worktree branches use `volli/<DISPLAY-ID>-<slug>`, such as `volli/VC-12-mcp-server`.

Keep each change focused. Do not include unrelated formatting, generated files, or refactors in the same pull request. Add or update tests when behavior changes.

Open a pull request against `main`. Describe the user-facing change, link the related issue or Ticket when one exists, and list the checks you ran. Attach screenshots or a recording to the pull request for visual changes; do not commit PR evidence to the repository.

This repository is private and stays publishable: write every commit as if it were public. Keep internal plans, research notes, strategy, business material, and product comparisons out of commits. Describe behavior and technical reasons in pull requests, comments, and test names rather than internal process history. `node scripts/check-public-content.mjs` checks the restricted documentation directories.

Maintainers review pull requests for product fit, implementation quality, and test coverage. Opening a pull request does not guarantee that it will be merged.

Contributions accepted into Volli are licensed under the [Apache License 2.0](LICENSE).

## Validation

Run the checks that cover your change before opening a pull request:

```bash
vp check
vp run --filter <touched-package> typecheck
# From the touched package's directory:
vp test run <focused-test-file> --maxWorkers="${VOLLI_CONCURRENCY_HINT:-1}"
node scripts/check-public-content.mjs
```

For changes to protected logic, run focused coverage with the package's configured thresholds intact. CI runs every package suite and the complete coverage and smoke gates. `CI gate` and CodeQL must be green on the pull request's current head; see [AGENTS.md](AGENTS.md) for the gate and compatibility rules.

The desktop performance harness is intentionally outside the unit and coverage lane because its fixture test writes a real-scale migrated database. See [Desktop performance benchmark](docs/performance-benchmark.md) for the measurement command, and run its focused checks with:

```bash
pnpm test:performance-harness
```

## Architecture pointers

Read [CONTEXT.md](CONTEXT.md) for product terms and [docs/DESIGN.md](docs/DESIGN.md) for the visual language. [AGENTS.md](AGENTS.md) describes package boundaries, local development commands, and project conventions.
