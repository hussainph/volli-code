# Contributing to Volli Code

Volli Code is a local-first macOS workspace for Tickets, Sessions, worktrees, and review. This guide covers the workflow used for changes to the app.

## Prerequisites

Use macOS, Node.js `^24.13.0`, and pnpm `11.10.0`. A `.nvmrc` carries the pin (`nvm use`), and the range is enforced rather than advisory: `pnpm install` hard-fails outside it (`engineStrict` in `pnpm-workspace.yaml`), and the desktop dev/start scripts preflight the running Node before anything spawns — an unsupported Node builds native modules (better-sqlite3, node-pty) against the wrong ABI, which surfaces later as a dead database and a greyed-out sign-in. Install dependencies from the repository root:

```bash
pnpm install
```

## Workflow

Start from an up-to-date `main` branch and make your change on a branch. Ticket worktree branches use `volli/<DISPLAY-ID>-<slug>`, such as `volli/VC-12-mcp-server`.

Keep each change focused. Do not include unrelated formatting, generated files, or refactors in the same pull request. Add or update tests when behavior changes.

Open a pull request against `main`. Describe the user-facing change, link the related issue or Ticket when one exists, and list the checks you ran. Include screenshots or a recording for visual changes.

Maintainers review pull requests for product fit, implementation quality, and test coverage. Opening a pull request does not guarantee that it will be merged.

Contributions accepted into Volli Code are licensed under the [Apache License 2.0](LICENSE).

## Validation

Run the checks that cover your change before opening a pull request:

```bash
pnpm run typecheck
pnpm test
pnpm run check
```

Run coverage when you add a branch or a renderer/store action:

```bash
pnpm run test:coverage
```

## Architecture pointers

Read [CONTEXT.md](CONTEXT.md) for product terms and [docs/DESIGN.md](docs/DESIGN.md) for the visual language. [AGENTS.md](AGENTS.md) describes package boundaries, local development commands, and project conventions.
